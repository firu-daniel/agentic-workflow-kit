// The runner core: executes a pipeline's steps in order, passes each output forward by step id, verifies every
// output (the step's own rules, then the pipeline's) and keeps one StepRecord per step; each attempt is one log line.
// A checkpoint (src/checkpoint.ts) lets a re-run resume at the first step not completed. A failed attempt is retried
// up to the step's retry policy with the previous failures handed to the next attempt; a thrown error backs off first,
// a verify failure retries at once. --dry-run prints what a run would do with each step and calls none.
import { checkpointStore } from './checkpoint.js';
import { createLogger, stdoutWriter, toText, type LineWriter } from './log.js';
import { DEFAULT_RETRY, NonRetryableError } from './types.js';
import type {
  Checkpoint, Logger, LlmClient, Pipeline, PipelineStep, PlanEntry, RetryPolicy, RunFlags, RunResult, StepContext, StepRecord, TokenUsage,
} from './types.js';

export interface RunnerOptions {
  flags: RunFlags;
  llm: LlmClient;
  /** Defaults to a key=value logger on stderr. Tests inject a capturing one. */
  log?: Logger;
  /** Where --dry-run prints the plan. Defaults to stdout. */
  out?: LineWriter;
  /** Defaults to a timestamp. */
  runId?: string;
  /** Directory of the per-pipeline checkpoint file. Defaults to `runs`. */
  runsDir?: string;
  /** Waits before a retry attempt. Defaults to setTimeout; tests inject a recorder. */
  sleep?: Sleep;
}

export type Sleep = (ms: number) => Promise<void>;
const NO_TOKENS: TokenUsage = { input: 0, output: 0 };
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const policy = (ps: PipelineStep): RetryPolicy => ({
  attempts: ps.retry?.attempts ?? DEFAULT_RETRY.attempts,
  baseDelayMs: ps.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
});

/** Runs the pipeline to completion or to the first step that fails. Never throws for a step failure. */
export async function runPipeline(pipeline: Pipeline, options: RunnerOptions): Promise<RunResult> {
  const runId = options.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const log = options.log ?? createLogger();
  const sleep = options.sleep ?? realSleep;
  const inputs: Record<string, unknown> = {};
  const records: StepRecord[] = [];
  const result = (ok: boolean): RunResult => ({ runId, pipeline: pipeline.name, ok, records });

  const duplicate = pipeline.steps.find((s, i) => pipeline.steps.findIndex((o) => o.id === s.id) !== i);
  if (duplicate) throw new Error(`pipeline "${pipeline.name}": duplicate step id "${duplicate.id}"`);

  const store = checkpointStore(options.runsDir ?? 'runs', pipeline, log);
  const completed: Checkpoint['completed'] = options.flags.fresh ? Object.create(null) : await store.load();

  log.info('run start', {
    run: runId, pipeline: pipeline.name, steps: pipeline.steps.length, resumed: Object.keys(completed).length,
  });
  // Nothing above writes to the file system: --dry-run returns here, --fresh deletes before the first write.
  if (options.flags.dryRun) {
    // What a real run would do with each step right now, given the loaded checkpoint.
    const plan: PlanEntry[] = pipeline.steps.map((ps) => ({
      id: ps.id,
      uses: ps.uses.name,
      params: ps.params,
      verify: { step: typeof ps.uses.verify === 'function', rules: ps.verify?.length ?? 0 },
      retry: policy(ps),
      gate: ps.gate === true,
      action: completed[ps.id] ? 'skip' : 'run',
    }));
    for (const line of formatPlan(pipeline.name, plan, store.file, options.flags.fresh)) (options.out ?? stdoutWriter)(line);
    return { ...result(true), plan };
  }
  if (options.flags.fresh) await store.clear();
  for (const ps of pipeline.steps) {
    const prior = completed[ps.id];
    if (prior) {
      const record: StepRecord = { id: ps.id, uses: ps.uses.name, status: 'resumed', attempts: 0, durationMs: 0, usage: { ...NO_TOKENS } };
      if (prior.artifact) record.artifact = prior.artifact;
      records.push(record);
      log.info('step', { run: runId, step: ps.id, uses: ps.uses.name, status: 'resumed' });
      inputs[ps.id] = prior.output;
      continue;
    }
    const ctx: StepContext = {
      runId, stepId: ps.id, params: ps.params, inputs, llm: options.llm, flags: options.flags, log, attempt: 1, previousFailures: [],
    };
    const { record, output } = await retryStep(ps, ctx, sleep);
    records.push(record);
    if (record.status === 'failed') {
      log.error('run failed', { run: runId, step: ps.id, attempts: record.attempts, error: record.error });
      return result(false);
    }
    inputs[ps.id] = output;
    completed[ps.id] = record.artifact ? { output, artifact: record.artifact } : { output };
    await store.save(completed);
  }
  await store.clear();
  log.info('run done', { run: runId, pipeline: pipeline.name, steps: records.length });
  return result(true);
}

/** One header line plus one line per step, params as JSON cut at 80 chars. Reads as a plan, not as log lines. */
function formatPlan(name: string, plan: PlanEntry[], file: string, fresh: boolean): string[] {
  const skipped = plan.filter((e) => e.action === 'skip').length;
  const width = Math.max(0, ...plan.map((e) => e.id.length));
  const checkpoint = skipped ? `${skipped} skipped (done in ${file})` : fresh ? 'checkpoint ignored (--fresh)' : 'no checkpoint';
  const header = `dry run ${name}: ${plan.length} steps, ${checkpoint}; no step is called; retry backoff applies after a thrown error only`;
  return [header, ...plan.map((e, i) => {
    const rules = e.verify.rules ? `${e.verify.rules} rule${e.verify.rules === 1 ? '' : 's'}` : '';
    const verify = [e.verify.step ? 'step.verify' : '', rules].filter(Boolean).join('+') || 'none';
    const params = toText(e.params);
    return `  ${i + 1}. ${e.id.padEnd(width)}  ${e.action.padEnd(4)}  uses=${e.uses} verify=${verify} retry=${e.retry.attempts}x${e.retry.baseDelayMs}ms`
      + `${e.gate ? ' gate' : ''} params=${params.length > 80 ? `${params.slice(0, 79)}…` : params}`;
  })];
}

/** One attempt's outcome: the record plus the raw data the retry loop needs to decide and to feed forward. */
interface Attempt {
  record: StepRecord;
  /** Only meaningful when `record.status === 'done'`. */
  output?: unknown;
  /** Verify failures, or the thrown error text; [] when the attempt passed. */
  failures: string[];
  /** False only for a thrown NonRetryableError. */
  retryable: boolean;
  /** True when the attempt threw (the retry backs off first); false for a verify failure (retried at once). */
  thrown: boolean;
}

/** Attempts a step up to `retry.attempts` times, handing the previous attempt's failures (or its error text) to the next
 * one through `previousFailures`. Before attempt n it waits baseDelayMs * 2^(n-2) if attempt n-1 threw, nothing if it
 * failed verify. A NonRetryableError ends the loop after any attempt. The returned record is the last attempt's, with
 * `durationMs`/`usage` summed across all attempts. */
async function retryStep(ps: PipelineStep, ctx: StepContext, sleep: Sleep): Promise<Attempt> {
  const { attempts, baseDelayMs } = policy(ps);
  let outcome = await attemptStep(ps, ctx);
  let durationMs = outcome.record.durationMs;
  const usage = { ...outcome.record.usage };
  for (let n = 2; outcome.record.status === 'failed' && outcome.retryable && n <= attempts; n++) {
    const delayMs = outcome.thrown ? baseDelayMs * 2 ** (n - 2) : 0;
    ctx.log.info('retry', { run: ctx.runId, step: ps.id, attempt: n, of: attempts, delayMs });
    if (delayMs) await sleep(delayMs);
    outcome = await attemptStep(ps, { ...ctx, attempt: n, previousFailures: outcome.failures });
    durationMs += outcome.record.durationMs;
    usage.input += outcome.record.usage.input;
    usage.output += outcome.record.usage.output;
  }
  return { ...outcome, record: { ...outcome.record, durationMs, usage } };
}

/** One attempt of one step: run, then verify (step's own rules first, pipeline rules after). */
async function attemptStep(ps: PipelineStep, ctx: StepContext): Promise<Attempt> {
  const started = Date.now();
  const record: StepRecord = {
    id: ps.id,
    uses: ps.uses.name,
    status: 'done',
    attempts: ctx.attempt,
    durationMs: 0,
    usage: { ...NO_TOKENS },
  };
  let output: unknown;
  let failures: string[];
  let retryable = true;
  let thrown = false;
  try {
    const res = await ps.uses.run(ctx);
    output = res.output;
    record.usage = { ...(res.usage ?? NO_TOKENS) };
    if (res.artifact) record.artifact = res.artifact;
    failures = [...((await ps.uses.verify?.(res.output, ctx)) ?? [])];
    for (const rule of ps.verify ?? []) failures.push(...(await rule(res.output, ctx)));
    if (failures.length) {
      record.status = 'failed';
      record.error = `verify: ${failures.join('; ')}`;
    }
  } catch (err) {
    record.status = 'failed';
    record.error = err instanceof Error ? err.message : String(err);
    failures = [record.error];
    retryable = !(err instanceof NonRetryableError);
    thrown = true;
  }
  record.durationMs = Date.now() - started;
  const fields: Record<string, unknown> = {
    run: ctx.runId,
    step: ps.id,
    uses: ps.uses.name,
    status: record.status,
    attempt: ctx.attempt,
    ms: record.durationMs,
    in: record.usage.input,
    out: record.usage.output,
  };
  if (record.error) fields.error = record.error;
  ctx.log[record.status === 'failed' ? 'warn' : 'info']('step', fields);
  return { record, output, failures, retryable, thrown };
}
