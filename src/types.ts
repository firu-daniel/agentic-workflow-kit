// The contracts the whole kit codes against. A pipeline is one file exporting a `Pipeline`:
// an ordered list of library steps, each with an id, its params, optional verify rules and
// optional retry settings. The runner (src/runner.ts) executes it; nothing else is needed.

/** Tokens consumed by one step attempt. Steps that make no LLM call report zeros. */
export interface TokenUsage {
  input: number;
  output: number;
}

/** CLI flags, resolved once per run and visible to every step. */
export interface RunFlags {
  /** Print the execution plan (what a run would do with each step now, given the checkpoint) and return without
   * calling a step or touching runs/. With --fresh nothing is skipped: every step not gated shows `run`, a gated one
   * `gate` unless --approve is passed. The checkpoint stays. */
  dryRun: boolean;
  /** Let gated steps run (see PipelineStep.gate). Without it the run stops before the first gated step not yet
   * completed, writes `runs/<pipeline>.review.md` and returns `ok: false` with a `gated` record. */
  approve: boolean;
  /** Delete the pipeline's checkpoint before starting, so every step runs again. */
  fresh: boolean;
}

/** Structured logger: `fields` are appended to the line as key=value pairs. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** The LLM slot steps see: one completion per call, no conversation state. Implemented three times in src/llm.ts —
 * the Claude Code CLI in headless mode (a subscription), the Anthropic client (an API key) and the offline mock;
 * `createLlm` there picks one from AWK_LLM, else from what is available. An error a retry cannot fix (a bad request,
 * a bad key, a refusal, an SDK error raised before any request was sent, an API status the CLI reports as such) is
 * thrown as NonRetryableError; anything else (rate limit, timeout, 5xx, network, an SDK error marked retryable, a CLI
 * exit without a status) is thrown as is, so the runner backs off and retries the step. */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export interface LlmRequest {
  /** The Anthropic backend sends none when this is unset; the Claude Code backend substitutes a neutral default
   * (`DEFAULT_SYSTEM_PROMPT` in src/llm.ts), so a call never inherits Claude Code's own agent system prompt. */
  system?: string;
  prompt: string;
  /** Output cap for this call; the client's default applies when absent. A response cut at the cap comes back with
   * `truncated: true` rather than an error (a retry with the same cap would be cut the same way). The Claude Code
   * backend does not apply it — the CLI has no output-cap flag — so there only the model's own ceiling cuts an answer. */
  maxTokens?: number;
  /** What the offline mock returns for this request, verbatim; the real client ignores it. A library step supplies
   * one that satisfies its own verify rules (a schema-valid object, a draft with the required sections), so a pipeline
   * runs green with no key. Without it the mock returns a canned text that names itself as a mock. */
  mockReply?: string;
}

export interface LlmResponse {
  text: string;
  usage: TokenUsage;
  /** The model stopped at `maxTokens` or at the context window: `text` is incomplete. The step decides what that
   * means — the library's LLM steps throw NonRetryableError, a retry at the same cap being cut the same way. */
  truncated: boolean;
}

/** What a step receives on each attempt. */
export interface StepContext<TParams = unknown> {
  runId: string;
  stepId: string;
  params: TParams;
  /** Outputs of the completed earlier steps, by step id. A step must not mutate them
   * (a compile-time guard only: nested values stay mutable). */
  inputs: Readonly<Record<string, unknown>>;
  llm: LlmClient;
  flags: RunFlags;
  log: Logger;
  /** 1 on the first attempt. */
  attempt: number;
  /** Verify failures (or the thrown error text) of the previous attempt; [] on the first. */
  previousFailures: readonly string[];
}

export interface StepResult<TOutput = unknown> {
  /** Must be JSON-serializable: it is written to the checkpoint and JSON round-tripped on resume. */
  output: TOutput;
  usage?: TokenUsage;
  /** Path of a file the step wrote (e.g. emit), surfaced in the run record. */
  artifact?: string;
}

/** A library step. `verify` returns failure strings; an empty list means pass. */
export interface Step<TParams = unknown, TOutput = unknown> {
  name: string;
  run(ctx: StepContext<TParams>): Promise<StepResult<TOutput>>;
  verify?(output: TOutput, ctx: StepContext<TParams>): string[] | Promise<string[]>;
}

/** A pipeline-level check on a step's output; same contract as Step.verify. */
export type VerifyRule<TOutput = unknown> = (
  output: TOutput,
  ctx: StepContext,
) => string[] | Promise<string[]>;

export interface RetryPolicy {
  /** Total attempts, the first one included; a value below 1 still makes one attempt. */
  attempts: number;
  /** Wait before attempt n is baseDelayMs * 2^(n-2) when attempt n-1 threw (rate limit, timeout, 5xx); a verify
   * failure retries at once, the correction coming from `previousFailures`; a step that needs a wait before its next
   * attempt (a truncated or rate-limited response it detects itself) should throw instead of returning failures.
   * Uncapped: the wait before the last attempt is baseDelayMs * 2^(attempts-2) (10 attempts at 1000 ms wait 512 s). */
  baseDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 1000 };

/** A value that becomes a file name under runs/ must match this: the pipeline name, which keys the checkpoint and the
 * review file (checked in src/cli.ts), and the run id, which keys the report (checked in src/runner.ts). */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One entry in a pipeline file. */
export interface PipelineStep<TParams = unknown, TOutput = unknown> {
  /** Unique within the pipeline; later steps read this step's output as `inputs[id]`. */
  id: string;
  /** The library step to run. */
  uses: Step<TParams, TOutput>;
  params: TParams;
  /** Run after `uses.verify`; any failure string fails the attempt. */
  verify?: VerifyRule<TOutput>[];
  /** Overrides DEFAULT_RETRY for this step, field by field. */
  retry?: Partial<RetryPolicy>;
  /** Human-in-the-loop gate: the runner stops before this step unless --approve is passed, writing what the step would
   * do and consume to `runs/<pipeline>.review.md` (src/review.ts) and keeping the checkpoint, so the --approve re-run
   * resumes the completed steps and runs this one first. Shown as `gate` in the --dry-run plan. */
  gate?: boolean;
}

export interface Pipeline {
  name: string;
  steps: PipelineStep<any, any>[];
}

/** Authoring helper: infers TParams/TOutput from `uses` so params and verify rules are type-checked. */
export function step<TParams, TOutput>(def: PipelineStep<TParams, TOutput>): PipelineStep<any, any> {
  return def;
}

/** Throw from a step to stop the run at once. Anything else thrown is retried. */
export class NonRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

/**
 * `runs/<pipeline>.checkpoint.json`: written after every successful step, read at the next start so the run
 * resumes at the first step not completed, deleted when the run completes. Ignored with a warning when the
 * step list no longer matches; `--fresh` deletes it up front. NOT detected: a changed param, or a changed
 * step implementation under the same `name`.
 */
export interface Checkpoint {
  /** Informational (the file name already keys by pipeline). */
  pipeline: string;
  /** The step list the checkpoint was written for, in order. */
  steps: { id: string; uses: string }[];
  /** Output (JSON round-tripped) and artifact of each completed step, by id. */
  completed: Record<string, { output: unknown; artifact?: string }>;
  updatedAt: string;
}

/** Per-step outcome kept by the runner; the run report (src/report.ts) renders one line per record.
 * `attempts` counts every attempt made; `durationMs` and `usage` are summed across them (backoff waits excluded);
 * `error` is the last attempt's. `resumed` = output taken from the checkpoint, not run: attempts 0, zero duration and
 * tokens. `gated` = the run stopped before this step for want of --approve: attempts 0, zero duration and tokens,
 * `artifact` = the review file; it is always the last record of a run with `ok: false` and no `failed` record. */
export type StepStatus = 'done' | 'failed' | 'resumed' | 'gated';

export interface StepRecord {
  id: string;
  uses: string;
  status: StepStatus;
  attempts: number;
  durationMs: number;
  usage: TokenUsage;
  error?: string;
  artifact?: string;
}

export interface RunResult {
  runId: string;
  pipeline: string;
  ok: boolean;
  records: StepRecord[];
  /** Present on a dry run only; `records` is then empty. */
  plan?: PlanEntry[];
  /** `runs/<runId>.md`, the report every run that is not a dry run writes (src/report.ts): one line per record, the
   * totals, the final artifact. Absent on a dry run, and when the write failed (logged as a warning; the run's outcome
   * stands). Never removed by the runner. */
  report?: string;
  /** The error a run threw outside a step, present only on the result the report was written from: the runner rethrows
   * that error, so no caller is handed this result. */
  error?: string;
}

/** One step of the --dry-run plan: the resolved settings and what a real run would do with the step right now. */
export interface PlanEntry {
  id: string;
  uses: string;
  params: unknown;
  /** Whether the library step has its own `verify`, and how many pipeline rules follow it. */
  verify: { step: boolean; rules: number };
  /** Resolved against DEFAULT_RETRY. */
  retry: RetryPolicy;
  gate: boolean;
  /** `skip` when the checkpoint already holds this step's output; `gate` when the step is gated and --approve is not
   * passed (a real run would stop there; the entries after it show what it would do once approved). */
  action: 'run' | 'skip' | 'gate';
}
