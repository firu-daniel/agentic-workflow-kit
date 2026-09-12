// The per-run report: `runs/<run id>.md`, written at the end of every run that is not a dry run, whatever the
// outcome — one line per step (status, attempts, duration, tokens, error, artifact), the totals, the final artifact
// and, for a run that did not complete, why — a step failure, a gate, or an error thrown outside a step (the runner
// reports that one before rethrowing). The checkpoint and the review file are run state and go when the run completes;
// the report is the run's evidence and is never removed by the runner. The runner (src/runner.ts) calls `writeReport`;
// everything else here renders the file. Core module: it must not import from src/steps/.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cell, clip, errorText } from './log.js';
import type { Logger, RunFlags, RunResult, StepRecord } from './types.js';

/** `<runsDir>/<runId>.md`, next to the checkpoint; the default run id is the start time, so `runs/<timestamp>.md`. */
export const reportFile = (dir: string, runId: string): string => path.join(dir, `${runId}.md`);

/** Per-cell cap on an error in the table; the closing line carries more of a failed step's error. */
export const REPORT_CELL_CHARS = 200;
/** Cap on the error text of the closing line: enough to read, never a page. */
export const REPORT_ERROR_CHARS = 2000;

/** Writes the report and returns the result with `report` set to the file. A write failure is logged as a warning
 * and leaves `report` unset — the run's outcome stands whether or not its report could be written. The runner calls
 * it for a completed, failed and gated run alike, and for a run that threw outside a step (`result.error`). */
export async function writeReport(dir: string, result: RunResult, started: Date, flags: RunFlags, log: Logger): Promise<RunResult> {
  const file = reportFile(dir, result.runId);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, renderReport(result, started, flags));
    log.info('run report', { run: result.runId, file });
    return { ...result, report: file };
  } catch (err) {
    log.warn('run report not written', { run: result.runId, file, reason: errorText(err) });
    return result;
  }
}

/** The report as markdown: a title with the outcome, one totals line, the step table, the final artifact and — when
 * the run did not complete — one closing line: `Failed:` with the step and its error, `Gated:` with the review file,
 * or `Stopped:` with the error a run threw outside a step. Every value on it is escaped like a cell, so nothing in an
 * error can open a row or a line of its own. Under 30 lines for a five-step pipeline. */
export function renderReport(result: RunResult, started: Date, flags: RunFlags, now: Date = new Date()): string {
  const { records } = result;
  const last = records.at(-1);
  const stopped = last?.status === 'failed' || last?.status === 'gated' ? last : undefined;
  const outcome = result.ok ? 'ok' : stopped?.status === 'gated' ? `gated before "${stopped.id}"` : stopped ? `failed at "${stopped.id}"` : 'stopped';
  const resumed = records.filter((r) => r.status === 'resumed').length;
  const retries = records.reduce((n, r) => n + Math.max(0, r.attempts - 1), 0);
  const input = records.reduce((n, r) => n + r.usage.input, 0);
  const output = records.reduce((n, r) => n + r.usage.output, 0);
  const set = (['approve', 'fresh'] as const).filter((f) => flags[f]).map((f) => `--${f}`);
  // A gated record's artifact is the review file (src/review.ts) — run state, named by the `Gated:` line, not the
  // run's deliverable — so the last record that produced one of its own is the artifact.
  const artifact = [...records].reverse().find((r) => r.artifact && r.status !== 'gated')?.artifact;
  const lines = [
    `# Run ${result.runId}: ${result.pipeline} ${outcome}`,
    '',
    `Started ${started.toISOString()}, ${Math.max(0, now.getTime() - started.getTime())} ms wall clock`
      + `${set.length ? ` with ${set.join(' ')}` : ''}; ${count(records.length, 'step')} (${resumed} resumed, ${count(retries, 'retry', 'retries')}),`
      + ` tokens in/out ${input}/${output}.`,
    '',
    '| # | step | uses | status | attempts | ms | tokens in/out | error | artifact |',
    '|---|---|---|---|---|---|---|---|---|',
    ...records.map((r, i) => row(i + 1, r)),
    '',
    `Artifact: ${artifact ? cell(artifact) : 'none'}`,
  ];
  const error = (text: string): string => cell(clip(text, REPORT_ERROR_CHARS));
  if (result.error !== undefined) {
    lines.push(`Stopped: ${error(result.error)}`);
  } else if (stopped?.status === 'failed') {
    lines.push(`Failed: step "${stopped.id}" (${stopped.uses}) after ${count(stopped.attempts, 'attempt')}: ${error(stopped.error ?? '')}`);
  } else if (stopped) {
    lines.push(`Gated: step "${stopped.id}" (${stopped.uses}) did not run; review ${stopped.artifact ?? 'the review file'}, then re-run with --approve.`);
  }
  return `${lines.join('\n')}\n`;
}

const row = (n: number, r: StepRecord): string =>
  `| ${n} | ${cell(r.id)} | ${cell(r.uses)} | ${r.status} | ${r.attempts} | ${r.durationMs} | ${r.usage.input}/${r.usage.output}`
  + ` | ${cell(clip(r.error ?? '', REPORT_CELL_CHARS))} | ${cell(r.artifact ?? '')} |`;

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
