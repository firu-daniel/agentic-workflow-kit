// The LLM slot behind `ctx.llm`: the `LlmClient` contract lives in src/types.ts; this file holds its two
// implementations and the selector. `anthropicLlm` calls the Messages API through the official SDK; `mockLlm` answers
// offline with the request's own `mockReply` (or a canned text) and prompt-proportional token counts, so a pipeline
// runs green with no key. `createLlm(env, log)` picks by environment — no flag: ANTHROPIC_API_KEY set → Anthropic,
// model from ANTHROPIC_MODEL (default DEFAULT_MODEL); absent → mock. Every call logs one `llm` line through the
// logger it is given (the CLI passes the run's logger, so the lines interleave with the step lines).
import Anthropic, { RetryableError } from '@anthropic-ai/sdk';
import { errorText } from './log.js';
import { NonRetryableError } from './types.js';
import type { LlmClient, LlmRequest, LlmResponse, Logger } from './types.js';

export const DEFAULT_MODEL = 'claude-sonnet-5';
/** Output cap when the request sets none: room for a long draft, well under the SDK's timeout scaling. */
export const DEFAULT_MAX_TOKENS = 8192;
/** The `model=` value the mock logs, so a report shows at a glance which mode a run used. */
export const MOCK_MODEL = 'mock';

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
 * Every other status (400, 401, 403, 404, 413, 422) means the same request would fail the same way. */
const isRetryableStatus = (status: number): boolean => status === 408 || status === 409 || status === 429 || status >= 500;

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
      // Both stop reasons cut the answer short: the output cap, and the model running out of context window.
      const cut = message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded';
      return { text, usage, truncated: cut };
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

/** The one place the CLI builds the slot: the Anthropic client when ANTHROPIC_API_KEY is set (model from
 * ANTHROPIC_MODEL, else DEFAULT_MODEL), the mock otherwise. Logs which mode was picked and why. */
export function createLlm(env: NodeJS.ProcessEnv, log: Logger): LlmClient {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.info('llm mode', { mode: 'mock', reason: 'ANTHROPIC_API_KEY not set' });
    return mockLlm({ log });
  }
  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  log.info('llm mode', { mode: 'anthropic', model });
  return anthropicLlm({ model, apiKey, log });
}
