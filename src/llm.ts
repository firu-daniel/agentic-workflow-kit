// The LLM slot behind `ctx.llm`: the `LlmClient` contract lives in src/types.ts; this file holds its three
// implementations and the selector. `anthropicLlm` calls the Messages API through the official SDK (billed to an API
// key); `claudeCodeLlm` shells out to the installed Claude Code CLI in headless mode (`claude -p`), which a Claude
// subscription covers; `mockLlm` answers offline with the request's own `mockReply` (or a canned text) and
// prompt-proportional token counts, so a pipeline runs green with no key. `createLlm(env, log)` picks by environment —
// no flag: AWK_LLM (claude-code | anthropic | mock) wins when set; otherwise ANTHROPIC_API_KEY set → Anthropic, else
// `claude` on PATH → Claude Code, else mock. The model comes from ANTHROPIC_MODEL (default DEFAULT_MODEL) for both real
// backends. Every call logs one `llm` line through the logger it is given (the CLI passes the run's logger, so the
// lines interleave with the step lines).
import Anthropic, { RetryableError } from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { errorText } from './log.js';
import { NonRetryableError } from './types.js';
import type { LlmClient, LlmRequest, LlmResponse, Logger } from './types.js';

export const DEFAULT_MODEL = 'claude-sonnet-5';
/** Output cap when the request sets none: room for a long draft, well under the SDK's timeout scaling. */
export const DEFAULT_MAX_TOKENS = 8192;
/** The `model=` value the mock logs, so a report shows at a glance which mode a run used. */
export const MOCK_MODEL = 'mock';
/** The Claude Code CLI, looked up on PATH; the CLI's own auth (a subscription login, or ANTHROPIC_API_KEY) applies. */
export const CLAUDE_BIN = 'claude';
/** What the Claude Code backend sends as `--system-prompt` when the request sets none: a neutral default, so the call
 * does not inherit the CLI's own agent system prompt. The Anthropic backend sends no system prompt at all. */
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';
/** The modes AWK_LLM accepts. */
export const LLM_MODES = ['claude-code', 'anthropic', 'mock'] as const;
export type LlmMode = (typeof LLM_MODES)[number];

/** The slice of the SDK client the Anthropic implementation calls; tests inject a fake. */
export interface MessagesApi {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface AnthropicLlmOptions {
  model: string;
  log: Logger;
  /** Read by the default client only; the SDK falls back to ANTHROPIC_API_KEY when absent. */
  apiKey?: string;
  /** Defaults to `new Anthropic({ apiKey })`: the SDK retries 408/409/429/5xx twice with its own backoff, then throws. */
  client?: MessagesApi;
}

/** Statuses the SDK already retried; after its retries a step-level retry, with a longer wait, can still succeed.
 * Every other status (400, 401, 403, 404, 413, 422) means the same request would fail the same way. The one HTTP
 * classification in the kit: the `fetchPages` and `emit` steps read it too, so a status means the same everywhere. */
export const isRetryableStatus = (status: number): boolean => status === 408 || status === 409 || status === 429 || status >= 500;

/** Both stop reasons cut the answer short: the output cap, and the model running out of context window. Shared by the
 * two real backends, which name them identically. */
const isCutStop = (stopReason: unknown): boolean => stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded';

export function anthropicLlm(options: AnthropicLlmOptions): LlmClient {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const started = Date.now();
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: options.model,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(request.system === undefined ? {} : { system: request.system }),
          messages: [{ role: 'user', content: request.prompt }],
        });
      } catch (err) {
        if (err instanceof Anthropic.APIError) {
          if (typeof err.status === 'number' && !isRetryableStatus(err.status)) {
            throw new NonRetryableError(`anthropic: ${errorText(err)}`, { cause: err });
          }
        } else if (err instanceof Anthropic.AnthropicError && !(err instanceof RetryableError)) {
          // An SDK error raised before any request was sent (a max_tokens above the non-streaming cap, say): the same
          // call fails the same way. RetryableError stays excluded — it is the SDK's own opt-in to a retry.
          throw new NonRetryableError(`anthropic: ${errorText(err)}`, { cause: err });
        }
        throw err;
      }
      const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
      const { usage: u } = message;
      const usage = { input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens };
      options.log.info('llm', { model: message.model, ms: Date.now() - started, in: usage.input, out: usage.output, stop: message.stop_reason });
      if (message.stop_reason === 'refusal') {
        // `category` is the stable handle (`explanation` is documented as unstable text); the details ride along as the cause.
        const category = message.stop_details?.category ?? 'no category';
        throw new NonRetryableError(`anthropic: the model refused this request (${category})`, { cause: message.stop_details ?? undefined });
      }
      return { text, usage, truncated: isCutStop(message.stop_reason) };
    },
  };
}

/** What `claudeCodeLlm` runs: the `claude` binary with `args`, `stdin` piped in, under `options.env` and killed after
 * `options.timeoutMs`. The default spawns it through PATH; the unit tests inject a fake. Resolves on any exit code
 * (the caller reads `code`); rejects when the process cannot be started, when it is killed by a signal (the timeout
 * kill included) and when its output overflows the buffer. */
export type ClaudeExec = (
  args: string[],
  stdin: string,
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A result JSON's output can be long; the CLI's stderr is diagnostics only. */
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
/** Wall-clock cap on one `claude` call, so a wedged child cannot hang a run for ever; `ClaudeCodeLlmOptions.timeoutMs`
 * overrides it. The kill at the cap is a signal, so it lands on the signal path: `claude-code: claude killed by SIGTERM`. */
export const EXEC_TIMEOUT_MS = 10 * 60_000;

export const defaultClaudeExec: ClaudeExec = (args, stdin, { env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const run = { env, maxBuffer: EXEC_MAX_BUFFER, timeout: timeoutMs };
    const child = execFile(CLAUDE_BIN, args, run, (err, stdout, stderr) => {
      const { code, signal } = (err ?? {}) as { code?: unknown; signal?: unknown };
      if (err && typeof code !== 'number') {
        // A signal kill (the timeout's included) and a buffer overflow get the context a bare "Command failed" lacks.
        // A spawn failure is rejected as it is, so the caller can still read its ENOENT / EACCES `code`.
        if (typeof signal === 'string') reject(new Error(`claude-code: claude killed by ${signal}`, { cause: err }));
        else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new Error(`claude-code: ${errorText(err)}`, { cause: err }));
        else reject(err);
        return;
      }
      resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr });
    });
    // A closed stdin (the CLI exiting early) must not surface as an unhandled stream error; the exit path reports it.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdin);
  });

export interface ClaudeCodeLlmOptions {
  model: string;
  log: Logger;
  /** Defaults to `defaultClaudeExec`; the unit tests inject a fake that answers with a canned result JSON. */
  exec?: ClaudeExec;
  /** The child's environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock cap on one call, passed to the exec; defaults to EXEC_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** The fields of the CLI's `--output-format json` result that the client reads (CC 2.1.269). */
interface ClaudeResultJson {
  result?: unknown;
  is_error?: unknown;
  stop_reason?: unknown;
  api_error_status?: unknown;
  total_cost_usd?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Error text is one line in the log and the step record; the full result rides along as the cause. */
const clip = (s: string): string => (s.length > 400 ? `${s.slice(0, 400)}…` : s);

/** One plain completion through `claude -p`: the prompt on stdin (long prompts, no quoting), every tool disabled, one
 * turn, no session saved, the machine's own Claude Code customizations kept out (`--safe-mode`, which leaves auth and
 * model selection working normally) and every MCP server outside a `--mcp-config` ignored (`--strict-mcp-config`).
 * `--system-prompt` goes on every call — the request's when it sets one, else DEFAULT_SYSTEM_PROMPT — so the backend
 * never inherits Claude Code's own agent prompt. The result JSON gives the text, the token usage (cache tokens summed
 * into `input`, as the SDK path does) and the API-equivalent cost, logged as `cost=` although a subscription bills
 * nothing. `maxTokens` is not applied: the CLI has no output-cap flag, so `truncated` only reflects a stop at the
 * model's own ceiling. A non-zero exit or `is_error` is thrown as a plain Error (a rate limit on the subscription's
 * window is the likely cause, so a step retry can succeed), except when the CLI reports an API status a retry cannot
 * fix (a 4xx other than 408/409/429), which is NonRetryableError. An empty prompt and a `claude` that cannot be run at
 * all (ENOENT / EACCES) are NonRetryableError too; a result that is not JSON is a plain Error, and any other exec
 * failure (a signal kill, a buffer overflow) is thrown as it is. */
export function claudeCodeLlm(options: ClaudeCodeLlmOptions): LlmClient {
  const exec = options.exec ?? defaultClaudeExec;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      // The CLI rejects an empty stdin with a usage error on stderr and no result JSON; fail legibly before spawning.
      if (!request.prompt) throw new NonRetryableError('claude-code: the prompt is empty');
      const started = Date.now();
      const args = [
        '-p', '--output-format', 'json', '--model', options.model, '--tools', '', '--max-turns', '1',
        '--no-session-persistence', '--safe-mode', '--strict-mcp-config',
        '--system-prompt', request.system ?? DEFAULT_SYSTEM_PROMPT,
      ];
      let code: number;
      let stdout: string;
      let stderr: string;
      try {
        ({ code, stdout, stderr } = await exec(args, request.prompt, { env, timeoutMs }));
      } catch (err) {
        // The binary vanished from PATH, or is not executable: every retry of this step would fail the same way.
        const spawnCode = (err as { code?: unknown } | null)?.code;
        if (spawnCode === 'ENOENT' || spawnCode === 'EACCES') {
          throw new NonRetryableError(`claude-code: cannot run \`claude\`: ${errorText(err)}`, { cause: err });
        }
        throw err;
      }
      let result: ClaudeResultJson;
      try {
        result = JSON.parse(stdout) as ClaudeResultJson;
      } catch (err) {
        const detail = stderr.trim() || stdout.trim() || 'empty output';
        throw new Error(`claude-code: exit ${code}, result is not JSON: ${clip(detail)}`, { cause: err });
      }
      const text = typeof result.result === 'string' ? result.result : '';
      const u = result.usage ?? {};
      const usage = { input: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens), output: num(u.output_tokens) };
      const stop = typeof result.stop_reason === 'string' ? result.stop_reason : 'unknown';
      // `cost=` is the CLI's own total, which counts its auxiliary model calls (title, summaries) as well; those
      // tokens are outside `usage`, so the cost and the in=/out= counts are on different bases.
      options.log.info('llm', {
        model: options.model, ms: Date.now() - started, in: usage.input, out: usage.output, stop,
        cost: Number(num(result.total_cost_usd).toFixed(6)),
      });
      if (code !== 0 || result.is_error === true) {
        const status = result.api_error_status;
        const message = `claude-code: exit ${code}${typeof status === 'number' ? `, api status ${status}` : ''}: ${clip(text || stderr.trim() || 'no message')}`;
        if (typeof status === 'number' && !isRetryableStatus(status)) throw new NonRetryableError(message, { cause: result });
        throw new Error(message, { cause: result });
      }
      return { text, usage, truncated: isCutStop(stop) };
    },
  };
}

export interface MockLlmOptions {
  log: Logger;
}

/** Offline and deterministic: `request.mockReply` verbatim when the step supplies one, else a canned text that names
 * itself as a mock and quotes the prompt's first line. Usage is estimated at four characters per token, so a mock run
 * (and its report) shows non-zero, prompt-proportional counts rather than zeros. The mock never reports
 * `truncated: true` and ignores `maxTokens`, so a step that branches on `truncated` needs a real run to exercise it. */
export function mockLlm(options: MockLlmOptions): LlmClient {
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const text = request.mockReply ?? cannedReply(request.prompt);
      const usage = { input: estimateTokens(`${request.system ?? ''}${request.prompt}`), output: estimateTokens(text) };
      options.log.info('llm', { model: MOCK_MODEL, ms: 0, in: usage.input, out: usage.output, stop: 'end_turn' });
      return { text, usage, truncated: false };
    },
  };
}

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

function cannedReply(prompt: string): string {
  const firstLine = prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return `[mock reply] offline mock, no model was called; the prompt began: ${firstLine}`;
}

/** An AWK_LLM the run cannot honour — a value outside LLM_MODES, or `claude-code` with no `claude` on PATH; the CLI
 * reports it as a usage error (exit code 2). */
export class LlmModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmModeError';
  }
}

const isMode = (v: string): v is LlmMode => (LLM_MODES as readonly string[]).includes(v);

/** A best-effort probe of PATH: true when `claude` resolves there to an executable file (the same lookup execFile
 * makes). POSIX only — no PATHEXT, so a `claude.cmd` or `claude.exe` is not found. */
export function claudeOnPath(env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(path.delimiter).filter(Boolean).some((dir) => {
    const file = path.join(dir, CLAUDE_BIN);
    try {
      // A directory carries the execute bit too, so what the entry is comes before what may be done with it.
      if (!statSync(file).isFile()) return false;
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The one place the CLI builds the slot. AWK_LLM (claude-code | anthropic | mock) decides when set, an unknown value
 * throws LlmModeError, and so does AWK_LLM=claude-code with no `claude` on PATH (asking for a backend that cannot run
 * is a usage error, not a mode to fall back from); unset, ANTHROPIC_API_KEY set → the Anthropic client, else `claude`
 * on PATH → the Claude Code CLI (the subscription), else the mock. Both real backends take the model from ANTHROPIC_MODEL (default
 * DEFAULT_MODEL). Logs which mode was picked and why. */
export function createLlm(env: NodeJS.ProcessEnv, log: Logger): LlmClient {
  const apiKey = env.ANTHROPIC_API_KEY;
  const requested = env.AWK_LLM;
  let mode: LlmMode;
  let reason: string;
  if (requested) {
    if (!isMode(requested)) throw new LlmModeError(`AWK_LLM="${requested}" is not a mode: expected one of ${LLM_MODES.join(', ')}`);
    mode = requested;
    reason = `AWK_LLM=${requested}`;
  } else if (apiKey) {
    mode = 'anthropic';
    reason = 'ANTHROPIC_API_KEY set';
  } else if (claudeOnPath(env)) {
    mode = 'claude-code';
    reason = 'claude on PATH';
  } else {
    mode = 'mock';
    reason = 'no AWK_LLM, no ANTHROPIC_API_KEY, no claude on PATH';
  }
  if (mode === 'claude-code' && requested && !claudeOnPath(env)) {
    throw new LlmModeError(
      'AWK_LLM=claude-code but no executable `claude` on PATH: install the Claude Code CLI or set AWK_LLM=anthropic|mock',
    );
  }
  if (mode === 'mock') {
    log.info('llm mode', { mode, reason });
    return mockLlm({ log });
  }
  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  log.info('llm mode', { mode, reason, model });
  return mode === 'anthropic' ? anthropicLlm({ model, apiKey, log }) : claudeCodeLlm({ model, log, env });
}
