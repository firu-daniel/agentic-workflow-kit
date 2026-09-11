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
  /** Print the execution plan and call no step. */
  dryRun: boolean;
  /** Let gated steps run (see PipelineStep.gate). */
  approve: boolean;
  /** Ignore an existing checkpoint and start from the first step. */
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
  /** Outputs of the completed earlier steps, by step id. */
  inputs: Record<string, unknown>;
  llm: LlmClient;
  flags: RunFlags;
  log: Logger;
  /** 1 on the first attempt. */
  attempt: number;
  /** Verify failures (or the thrown error text) of the previous attempt; [] on the first. */
  previousFailures: string[];
}

export interface StepResult<TOutput = unknown> {
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
  /** Total attempts, the first one included. */
  attempts: number;
  /** Wait before attempt n is baseDelayMs * 2^(n-2). */
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
  /** Overrides DEFAULT_RETRY for this step. */
  retry?: Partial<RetryPolicy>;
  /** The runner stops before this step unless --approve is passed (human-in-the-loop gate). */
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

/** Per-step outcome kept by the runner; the run report renders one line per record. */
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
}
