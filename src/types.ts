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
   * calling a step or touching runs/. With --fresh the plan shows every step running; the checkpoint stays. */
  dryRun: boolean;
  /** Let gated steps run (see PipelineStep.gate). Parsed and passed through; not enforced until the approval gate lands. */
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

/** The LLM slot steps see. Implemented in src/llm.ts (Anthropic client and MockLlm). */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export interface LlmRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  usage: TokenUsage;
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
  /** Human-in-the-loop gate: the runner is to stop before this step unless --approve is passed. Not enforced yet — the
   * approval gate reads it; today it only shows in the --dry-run plan. */
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

/** Per-step outcome kept by the runner; the run report renders one line per record.
 * `attempts` counts every attempt made; `durationMs` and `usage` are summed across them (backoff waits excluded);
 * `error` is the last attempt's. `resumed` = output taken from the checkpoint, not run: attempts 0, zero duration and tokens. */
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
  /** `skip` when the checkpoint already holds this step's output. */
  action: 'run' | 'skip';
}
