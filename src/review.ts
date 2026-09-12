// The approval gate: a step marked `gate: true` does not run unless --approve is passed. Instead the run stops there,
// writes `runs/<pipeline>.review.md` — what the step would do (its params) and what it would consume (the outputs it
// reads, in full), plus the completed steps — and returns a `gated` record. The checkpoint stays, so the --approve
// re-run resumes past the completed steps and runs the gated step first. The runner (src/runner.ts) calls
// `stopAtGate`; everything else here renders the file. Core module: it must not import from src/steps/.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prettyText } from './log.js';
import type { Logger, Pipeline, PipelineStep, StepRecord } from './types.js';

/** `<runsDir>/<pipeline>.review.md`, next to the checkpoint. */
export const reviewFile = (dir: string, pipeline: string): string => path.join(dir, `${pipeline}.review.md`);

/** Per-rendered-output character cap: a fetched site must not turn the review into megabytes. */
export const REVIEW_MAX_CHARS = 100_000;

/** Writes the review file, logs the stop and returns the gated step's record: status `gated`, no attempt, no tokens,
 * `artifact` = the review file. The runner pushes it and returns `ok: false` without touching the checkpoint. */
export async function stopAtGate(
  dir: string, pipeline: Pipeline, ps: PipelineStep, records: readonly StepRecord[], inputs: Readonly<Record<string, unknown>>,
  runId: string, log: Logger,
): Promise<StepRecord> {
  const file = reviewFile(dir, pipeline.name);
  await mkdir(dir, { recursive: true });
  await writeFile(file, renderReview(pipeline, ps, records, inputs, runId));
  log.warn('run gated', { run: runId, step: ps.id, uses: ps.uses.name, review: file });
  return { id: ps.id, uses: ps.uses.name, status: 'gated', attempts: 0, durationMs: 0, usage: { input: 0, output: 0 }, artifact: file };
}

/** The review as markdown. The outputs shown in full are the ones the gated step names in a `from` param (a step id or
 * a list of them — the library's convention); a step that names none, or whose ids name no output, shows every
 * completed output. A named id that is no earlier step's output is flagged: it fails the step the moment the gate is
 * approved (src/steps/shared.ts). Every rendered value goes in a fence, so a consumed output's own headings cannot
 * pass for the review's. */
export function renderReview(
  pipeline: Pipeline, ps: PipelineStep, records: readonly StepRecord[], inputs: Readonly<Record<string, unknown>>,
  runId: string, now: Date = new Date(),
): string {
  const named = fromIds(ps.params);
  const ids = named.filter((id) => Object.hasOwn(inputs, id));
  const shown = ids.length ? ids : Object.keys(inputs);
  const done = records.filter((r) => r.status === 'done' || r.status === 'resumed');
  const lines = [
    `# Review: ${pipeline.name} stopped before "${ps.id}" (${ps.uses.name})`,
    '',
    `Run ${runId}, ${now.toISOString()}.`,
    '',
    `Step \`${ps.id}\` is marked \`gate: true\` and \`--approve\` was not passed, so it did not run and nothing after it did.`,
    done.length
      ? `The ${done.length} completed step${done.length === 1 ? '' : 's'} ${done.length === 1 ? 'is' : 'are'} in the checkpoint and will resume.`
      : 'No step has completed yet; nothing is in the checkpoint.',
    'Re-run the same command with `--approve` added; for a pipeline run by name:',
    '',
    `    npm run start -- --pipeline ${pipeline.name} --approve`,
    '',
    `## Step "${ps.id}" would run with`,
    '',
    fence(prettyText(ps.params), 'json'),
    '',
    ...named.filter((id) => !Object.hasOwn(inputs, id))
      .flatMap((id) => [`Warning: input "${id}" is not the output of an earlier step; approving will fail this step.`, '']),
    ...shown.flatMap((id) => [`## Input "${id}" (output of step "${id}")`, '', fence(clip(prettyText(inputs[id])), ''), '']),
    ...(done.length ? [
      '## Completed steps',
      '',
      '| # | step | uses | status | attempts | ms | tokens in/out | artifact |',
      '|---|---|---|---|---|---|---|---|',
      ...done.map((r, i) =>
        `| ${i + 1} | ${cell(r.id)} | ${cell(r.uses)} | ${r.status} | ${r.attempts} | ${r.durationMs} | ${r.usage.input}/${r.usage.output} | ${cell(r.artifact ?? '')} |`),
      '',
    ] : []),
  ];
  return lines.join('\n');
}

/** `from` as the step library reads it: a string or a list of strings; anything else means "no named inputs".
 * `Object.hasOwn` does the lookup, so an id like `constructor` is a missing input, not Object.prototype's. */
function fromIds(params: unknown): string[] {
  if (typeof params !== 'object' || params === null || !('from' in params)) return [];
  const from = (params as { from: unknown }).from;
  if (typeof from === 'string') return [from];
  return Array.isArray(from) ? from.filter((v): v is string => typeof v === 'string') : [];
}

/** One markdown table cell: a `|` would open a column and a newline would end the row, so both are escaped. */
const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\r?\n/g, '\\n');

const clip = (text: string): string =>
  text.length <= REVIEW_MAX_CHARS ? text : `${text.slice(0, REVIEW_MAX_CHARS)}\n[… cut at ${REVIEW_MAX_CHARS} characters]`;

/** A fenced block whose fence is longer than any backtick run inside, so the content cannot close it early. */
function fence(text: string, lang: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}
