// The command behind `npm run start`: parses the flags, loads `pipelines/<name>.ts` (or a path to a pipeline file),
// checks that its default export has the Pipeline shape, and hands it to the runner with the flags and the LLM slot
// (src/llm.ts picks the Claude Code CLI, the Anthropic client or the offline mock from the environment). src/index.ts binds `main` to the
// process; everything here is importable so the tests can drive the pieces without spawning one.
// Exit codes: 0 a completed run, a dry run or --help; 1 a step failed after its retries (the step id is in the
// message) or the run threw; 2 a usage error (an unknown flag, an AWK_LLM value that is not a mode, or
// AWK_LLM=claude-code with no claude on PATH), or a pipeline
// file that cannot be found, cannot be loaded, or lacks a required field (the path and the field are named). Log lines go to stderr; the plan and the summary to stdout.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createLlm, LlmModeError } from './llm.js';
import { createLogger, errorText } from './log.js';
import { runPipeline } from './runner.js';
import type { LlmClient, Pipeline, RunFlags, RunResult } from './types.js';

export const USAGE = `Usage: npm run start -- --pipeline <name> [--dry-run] [--approve] [--fresh]

  --pipeline <name>  runs pipelines/<name>.ts; a value containing "/" is a path to a pipeline file, resolved
                     against the cwd (under npm run start: the package root, where runs/ lands too)
  --dry-run          print what a run would do with each step, given the checkpoint, and call none
  --approve          let gated steps run (gates are parsed but not enforced yet; that lands with the approval gate)
  --fresh            delete the pipeline's checkpoint first, so every step runs again
  --help, -h         this text

Environment: AWK_LLM picks how steps that call the LLM are served — claude-code (the installed Claude Code CLI in
headless mode, through the CLI's own login: a Claude subscription, or ANTHROPIC_API_KEY when it is set in the
environment, which the CLI prefers; a step's maxTokens does not apply, the CLI having no output-cap flag), anthropic
(the Anthropic API through the SDK, billed to ANTHROPIC_API_KEY; ANTHROPIC_BASE_URL is honoured, which is how the tests
point it at a local stub) or mock (an offline mock answers every call, so a pipeline runs green with no key). Unset,
the mode follows what is available: ANTHROPIC_API_KEY set → anthropic, else claude on PATH → claude-code, else mock.
Both real modes take the model from ANTHROPIC_MODEL (default claude-sonnet-5).

Exit code 0: the run completed, or --dry-run / --help. 1: a step failed after its retries (the step id is in the
message). 2: a usage error (an unknown flag, an AWK_LLM value that is not a mode, or AWK_LLM=claude-code with no claude
on PATH), or a pipeline file that cannot be found or loaded, or lacks a required field.
Log lines go to stderr; the dry-run plan and the final summary go to stdout.
`;

/** Where `--pipeline <name>` looks: the package's own pipelines/ directory, wherever the command is run from. */
export const PIPELINES_DIR = fileURLToPath(new URL('../pipelines/', import.meta.url));

export interface CliArgs {
  pipeline?: string;
  flags: RunFlags;
  help: boolean;
}

/** A pipeline file that cannot be used; the message names the file (exit code 2). */
export class PipelineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PipelineError';
  }
}

/** Strict: an unknown flag, a positional argument or `--pipeline` without a value throws (a TypeError from node:util). */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      pipeline: { type: 'string' },
      'dry-run': { type: 'boolean' },
      approve: { type: 'boolean' },
      fresh: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return {
    pipeline: values.pipeline,
    help: values.help === true,
    flags: { dryRun: values['dry-run'] === true, approve: values.approve === true, fresh: values.fresh === true },
  };
}

const isPath = (spec: string): boolean => spec.includes('/');

/** `<name>` → `<PIPELINES_DIR>/<name>.ts`; a value containing "/" is a file path, resolved against the cwd. */
export function resolvePipelineFile(spec: string): string {
  return isPath(spec) ? path.resolve(spec) : path.join(PIPELINES_DIR, `${spec}.ts`);
}

/** Resolves, imports and shape-checks a pipeline file. Throws PipelineError with the file path in the message. */
export async function loadPipeline(spec: string): Promise<{ file: string; pipeline: Pipeline }> {
  const file = resolvePipelineFile(spec);
  const stats = await stat(file).catch(() => undefined);
  if (!stats) {
    const hint = !isPath(spec) && spec.endsWith('.ts') ? ' (pass the name without .ts, or a path containing "/")' : '';
    throw new PipelineError(`pipeline "${spec}" not found: expected ${file}${hint}`);
  }
  if (!stats.isFile()) throw new PipelineError(`pipeline "${spec}" is not a file: ${file}`);
  let mod: { default?: unknown };
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    throw new PipelineError(`${file}: failed to load: ${errorText(err)}`, { cause: err });
  }
  return { file, pipeline: checkPipeline(mod.default, file) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** The name keys the checkpoint file (runs/<name>.checkpoint.json), so it must be a plain file name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(file: string, field: string, expected: string): never {
  throw new PipelineError(`${file}: ${field} ${expected}`);
}

/** Checks a default export against the Pipeline contract field by field; the first failure names the field. */
export function checkPipeline(value: unknown, file: string): Pipeline {
  if (!isRecord(value)) fail(file, 'default export', 'must be the pipeline object: export default { name, steps }');
  if (typeof value.name !== 'string' || !NAME.test(value.name)) {
    fail(file, 'name', 'must be a file-name-safe string (letters, digits, . _ -); it keys the checkpoint file');
  }
  if (!Array.isArray(value.steps)) fail(file, 'steps', 'must be an array of steps');
  const ids = new Set<string>();
  value.steps.forEach((s: unknown, i: number) => {
    const at = `steps[${i}]`;
    if (!isRecord(s)) fail(file, at, 'must be a step object: { id, uses, params }');
    if (typeof s.id !== 'string' || !s.id) fail(file, `${at}.id`, 'must be a non-empty string');
    if (ids.has(s.id)) fail(file, `${at}.id`, `"${s.id}" is already used by an earlier step`);
    ids.add(s.id);
    if (!('params' in s)) fail(file, `${at}.params`, 'is required (pass undefined for a step that takes none)');
    if (!isRecord(s.uses) || typeof s.uses.name !== 'string' || typeof s.uses.run !== 'function') {
      fail(file, `${at}.uses`, 'must be a library step: { name, run }');
    }
    if (s.uses.verify !== undefined && typeof s.uses.verify !== 'function') fail(file, `${at}.uses.verify`, 'must be a function');
    if (s.verify !== undefined && !(Array.isArray(s.verify) && s.verify.every((r) => typeof r === 'function'))) {
      fail(file, `${at}.verify`, 'must be an array of rule functions');
    }
    if (s.retry !== undefined && !isRecord(s.retry)) fail(file, `${at}.retry`, 'must be an object: { attempts?, baseDelayMs? }');
    for (const key of ['attempts', 'baseDelayMs']) {
      if (s.retry?.[key] !== undefined && typeof s.retry[key] !== 'number') fail(file, `${at}.retry.${key}`, 'must be a number');
    }
    if (s.gate !== undefined && typeof s.gate !== 'boolean') fail(file, `${at}.gate`, 'must be a boolean');
  });
  return value as unknown as Pipeline;
}

/** Runs the command and returns the exit code; writes only to process.stdout / process.stderr. */
export async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${errorText(err)}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.pipeline) {
    process.stderr.write(`error: --pipeline <name> is required\n\n${USAGE}`);
    return 2;
  }
  let pipeline: Pipeline;
  try {
    ({ pipeline } = await loadPipeline(args.pipeline));
  } catch (err) {
    process.stderr.write(`error: ${errorText(err)}\n`);
    return 2;
  }
  // One logger for the run and the LLM client, so the `llm` lines interleave with the step lines on stderr.
  const log = createLogger();
  let llm: LlmClient;
  try {
    llm = createLlm(process.env, log);
  } catch (err) {
    if (!(err instanceof LlmModeError)) throw err;
    process.stderr.write(`error: ${err.message}\n`);
    return 2;
  }
  let result: RunResult;
  try {
    result = await runPipeline(pipeline, { flags: args.flags, llm, log });
  } catch (err) {
    // The runner throws only outside a step: an unreadable checkpoint, or an output the checkpoint cannot serialize.
    process.stderr.write(`error: pipeline "${pipeline.name}": ${errorText(err)}\n`);
    return 1;
  }
  if (result.plan) return 0;
  if (!result.ok) {
    // A run can also stop without a failed step (a gate that was not approved); the failed record only shapes the message.
    const failed = result.records.find((r) => r.status === 'failed');
    if (!failed) {
      process.stderr.write(`error: run ${result.runId} stopped: ${pipeline.name} did not complete\n`);
      return 1;
    }
    const attempts = `${failed.attempts} attempt${failed.attempts === 1 ? '' : 's'}`;
    process.stderr.write(`error: run ${result.runId} failed at step "${failed.id}" (${failed.uses}) after ${attempts}: ${failed.error}\n`);
    return 1;
  }
  const count = result.records.length;
  const resumed = result.records.filter((r) => r.status === 'resumed').length;
  process.stdout.write(`run ${result.runId} ok: ${pipeline.name}, ${count} step${count === 1 ? '' : 's'}${resumed ? ` (${resumed} resumed)` : ''}\n`);
  return 0;
}
