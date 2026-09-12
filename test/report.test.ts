// The per-run report: rendering (src/report.ts renderReport) and the runner writing it at the end of every run that
// is not a dry run. Run with `npm test` (node:test through tsx).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createLogger } from '../src/log.js';
import { renderReport, reportFile, REPORT_CELL_CHARS, REPORT_ERROR_CHARS, writeReport } from '../src/report.js';
import { runPipeline } from '../src/runner.js';
import type { RunnerOptions } from '../src/runner.js';
import { NonRetryableError, type LlmClient, type Pipeline, type RunFlags, type RunResult, type Step, type StepRecord } from '../src/types.js';

const runsDir = await mkdtemp(path.join(tmpdir(), 'awk-report-'));
after(() => rm(runsDir, { recursive: true, force: true }));
const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);
const noLlm: LlmClient = { complete: async () => { throw new Error('no LLM in this test'); } };
const flags = (over: Partial<RunFlags> = {}): RunFlags => ({ dryRun: false, approve: false, fresh: false, ...over });
const options = (lines: string[] = [], over: Partial<RunFlags> = {}): RunnerOptions =>
  ({ flags: flags(over), llm: noLlm, log: createLogger((l) => lines.push(l)), runsDir, sleep: async () => {} });

const record = (over: Partial<StepRecord>): StepRecord =>
  ({ id: 'seed', uses: 'constant', status: 'done', attempts: 1, durationMs: 12, usage: { input: 3, output: 5 }, ...over });
const started = new Date('2026-09-12T10:00:00.000Z');
const now = new Date('2026-09-12T10:00:07.655Z');
const result = (ok: boolean, records: StepRecord[]): RunResult => ({ runId: '2026-09-12T10-00-00-000Z', pipeline: 'demo', ok, records });

// --- renderReport --------------------------------------------------------------------------------------------------

test('a completed five-step run renders under 30 lines: title, totals, one row per step, the last artifact', () => {
  const records = [
    record({ id: 'fetch', uses: 'fetchPages', usage: { input: 0, output: 0 } }),
    record({ id: 'facts', uses: 'extract', attempts: 2, durationMs: 800, usage: { input: 900, output: 200 } }),
    record({ id: 'outline', uses: 'plan', status: 'resumed', attempts: 0, durationMs: 0, usage: { input: 0, output: 0 } }),
    record({ id: 'post', uses: 'draft', usage: { input: 1200, output: 600 } }),
    record({ id: 'publish', uses: 'emit', usage: { input: 0, output: 0 }, artifact: 'out/changelog.md' }),
  ];
  const text = renderReport(result(true, records), started, flags({ approve: true }), now);
  const lines = text.split('\n');
  assert.ok(lines.length < 30, `${lines.length} lines`);
  assert.equal(lines[0], '# Run 2026-09-12T10-00-00-000Z: demo ok');
  assert.equal(lines[2], 'Started 2026-09-12T10:00:00.000Z, 7655 ms wall clock with --approve; 5 steps (1 resumed, 1 retry), tokens in/out 2100/800.');
  assert.equal(lines[4], '| # | step | uses | status | attempts | ms | tokens in/out | error | artifact |');
  assert.equal(lines[6], '| 1 | fetch | fetchPages | done | 1 | 12 | 0/0 |  |  |');
  assert.equal(lines[7], '| 2 | facts | extract | done | 2 | 800 | 900/200 |  |  |');
  assert.equal(lines[8], '| 3 | outline | plan | resumed | 0 | 0 | 0/0 |  |  |');
  assert.equal(lines[10], '| 5 | publish | emit | done | 1 | 12 | 0/0 |  | out/changelog.md |');
  assert.equal(lines[12], 'Artifact: out/changelog.md');
  assert.equal(text.at(-1), '\n', 'ends with one newline');
  assert.doesNotMatch(text, /^Failed:|^Gated:/m);
});

test('a failed run names the step in the title; the cell and the closing line both escape the error and clip it', () => {
  // The pipe and the newline sit before the cell's cut, so both lines really escape them rather than dropping them.
  const error = `verify: a | b\nc ${'x'.repeat(REPORT_CELL_CHARS)}`;
  const records = [record({}), record({ id: 'boom', uses: 'bomb', status: 'failed', attempts: 3, error })];
  const text = renderReport(result(false, records), started, flags(), now);
  assert.match(text, /^# Run \S+: demo failed at "boom"\n/);
  assert.match(text, /; 2 steps \(0 resumed, 2 retries\), /);
  const lines = text.split('\n');
  const row = lines.find((l) => l.startsWith('| 2 |'));
  assert.ok(row);
  assert.equal(row.split(' | ').length, 9, 'the escaped pipe keeps the row at nine columns');
  assert.match(row, /\| verify: a \\\| b\\nc x+… \[cut at 200 characters\] \|  \|$/);
  assert.match(text, /\nArtifact: none\nFailed: step "boom" \(bomb\) after 3 attempts: verify: a \\\| b\\nc x+\n$/,
    'the closing line carries the whole error, escaped like a cell: nothing in it can start a markdown line');
  assert.equal(lines.filter((l) => l.startsWith('#')).length, 1, 'one title, whatever the error says');
  assert.equal(lines.filter((l) => l.startsWith('|')).length, 4, 'two rows plus the header and the separator');
});

test('the closing line clips an error past REPORT_ERROR_CHARS', () => {
  const records = [record({ id: 'boom', status: 'failed', error: 'e'.repeat(REPORT_ERROR_CHARS + 1) })];
  const text = renderReport(result(false, records), started, flags(), now);
  assert.match(text, new RegExp(`\\nFailed: step "boom" \\(constant\\) after 1 attempt: e{${REPORT_ERROR_CHARS}}… \\[cut at ${REPORT_ERROR_CHARS} characters\\]\\n$`));
});

const gate = (over: Partial<StepRecord> = {}): StepRecord =>
  record({ id: 'publish', uses: 'emit', status: 'gated', attempts: 0, durationMs: 0, usage: { input: 0, output: 0 }, artifact: 'runs/demo.review.md', ...over });

test('a gated run names the step in the title, reports no artifact of its own and says how to continue', () => {
  const text = renderReport(result(false, [record({}), gate()]), started, flags(), now);
  assert.match(text, /^# Run \S+: demo gated before "publish"\n/);
  assert.match(text, /\n\| 2 \| publish \| emit \| gated \| 0 \| 0 \| 0\/0 \|  \| runs\/demo\.review\.md \|\n/);
  assert.match(text, /\nArtifact: none\nGated: step "publish" \(emit\) did not run; review runs\/demo\.review\.md, then re-run with --approve\.\n$/,
    'the review file is run state, named by the Gated line; a gated run produced no artifact');
});

test('the artifact is the last one a step produced, and a later gate does not shadow it', () => {
  const records = [record({ id: 'first', uses: 'emit', artifact: 'out/first.md' }), record({ id: 'make', uses: 'emit', artifact: 'out/real.md' }), gate({ id: 'check' })];
  const text = renderReport(result(false, records), started, flags(), now);
  assert.match(text, /\nArtifact: out\/real\.md\n/, 'the last emit artifact, not the first and not the review file');
  assert.match(text, /\nGated: step "check" \(emit\) did not run; review runs\/demo\.review\.md, /);
});

test('cells escape a pipe and a newline in a step id, a library-step name and an artifact path', () => {
  const records = [record({ id: 'a|b', uses: 'c\nd', artifact: 'out/e|f.md' })];
  const text = renderReport(result(true, records), started, flags(), now);
  assert.match(text, /\n\| 1 \| a\\\|b \| c\\nd \| done \| 1 \| 12 \| 3\/5 \|  \| out\/e\\\|f\.md \|\n/);
  assert.match(text, /\nArtifact: out\/e\\\|f\.md\n$/);
});

test('a run with no record (a gate on the first step aside) renders "stopped" and no rows; a negative clock reads 0 ms', () => {
  const text = renderReport(result(false, []), now, flags({ fresh: true }), started);
  assert.match(text, /^# Run \S+: demo stopped\n\nStarted 2026-09-12T10:00:07\.655Z, 0 ms wall clock with --fresh; 0 steps \(0 resumed, 0 retries\), tokens in\/out 0\/0\.\n/);
  assert.match(text, /\n\|---\|---\|---\|---\|---\|---\|---\|---\|---\|\n\nArtifact: none\n$/);
});

// --- writeReport and the runner ------------------------------------------------------------------------------------

const constant: Step<{ value: string }, string> = { name: 'constant', async run(ctx) { return { output: ctx.params.value, usage: { input: 3, output: 5 } }; } };
const bomb: Step<undefined, never> = { name: 'bomb', async run() { throw new NonRetryableError('the fuse was lit'); } };
/** An output the checkpoint cannot serialize, so `store.save` throws out of the runner after the step itself passed. */
const circular: Step<undefined, unknown> = {
  name: 'circular',
  async run() { const loop: Record<string, unknown> = {}; loop.self = loop; return { output: loop }; },
};

test('a completed run writes runs/<runId>.md, names it on the result and in the log, and leaves it after clearing the checkpoint', async () => {
  const lines: string[] = [];
  const pipeline: Pipeline = { name: 'report-done', steps: [{ id: 'seed', uses: constant, params: { value: 'hi' } }] };
  const res = await runPipeline(pipeline, { ...options(lines), runId: 'rp1' });
  assert.equal(res.ok, true);
  assert.equal(res.report, reportFile(runsDir, 'rp1'));
  assert.equal(await exists(path.join(runsDir, 'report-done.checkpoint.json')), false, 'the checkpoint is gone');
  const text = await readFile(res.report!, 'utf8');
  assert.match(text, /^# Run rp1: report-done ok\n/);
  assert.match(text, /\n\| 1 \| seed \| constant \| done \| 1 \| \d+ \| 3\/5 \|  \|  \|\n/);
  assert.ok(lines.some((l) => /info run report run=rp1 file=\S+rp1\.md$/.test(l)), lines.join('\n'));
  const done = lines.findIndex((l) => l.includes('run done'));
  const reported = lines.findIndex((l) => l.includes('run report'));
  assert.ok(done >= 0 && reported >= 0 && done < reported, `run done then run report, got ${done} and ${reported}`);
});

test('a failed run and a gated run write their report too; a dry run writes none', async () => {
  const failing: Pipeline = { name: 'report-failed', steps: [{ id: 'boom', uses: bomb, params: undefined }] };
  const failed = await runPipeline(failing, { ...options(), runId: 'rp2' });
  assert.equal(failed.ok, false);
  assert.match(await readFile(failed.report!, 'utf8'), /^# Run rp2: report-failed failed at "boom"\n[^]*\nFailed: step "boom" \(bomb\) after 1 attempt: the fuse was lit\n$/);

  const gated: Pipeline = { name: 'report-gated', steps: [{ id: 'seed', uses: constant, params: { value: 'hi' } }, { id: 'publish', uses: constant, params: { value: 'x' }, gate: true }] };
  const stop = await runPipeline(gated, { ...options(), runId: 'rp3' });
  assert.equal(stop.ok, false);
  assert.match(await readFile(stop.report!, 'utf8'),
    /^# Run rp3: report-gated gated before "publish"\n[^]*\nArtifact: none\nGated: step "publish" \(constant\) did not run; review \S+report-gated\.review\.md, /);

  const dry = await runPipeline(gated, { ...options([], { dryRun: true }), out: () => {}, runId: 'rp4' });
  assert.equal(dry.report, undefined);
  assert.equal(await exists(reportFile(runsDir, 'rp4')), false);
});

test('a run that throws outside a step reports it as stopped before the error reaches the caller', async () => {
  const pipeline: Pipeline = { name: 'report-threw', steps: [{ id: 'loop', uses: circular, params: undefined }] };
  await assert.rejects(runPipeline(pipeline, { ...options(), runId: 'rp5' }), /circular structure/);
  const text = await readFile(reportFile(runsDir, 'rp5'), 'utf8');
  assert.match(text, /^# Run rp5: report-threw stopped\n/);
  assert.match(text, /\n\| 1 \| loop \| circular \| done \| 1 \| \d+ \| 0\/0 \|  \|  \|\n/, 'the step that ran is on the table');
  assert.match(text, /\nArtifact: none\nStopped: [^\n]*circular structure[^\n]*\n$/);
});

test('a runId that is not file-name-safe throws before anything is read or written', async () => {
  // Its own runs directory, not created yet, so `../escaped` would land next to it and inside the temp tree.
  const dir = path.join(runsDir, 'runid');
  const pipeline: Pipeline = { name: 'report-runid', steps: [{ id: 'seed', uses: constant, params: { value: 'hi' } }] };
  for (const runId of ['../escaped', 'nested/deep']) {
    await assert.rejects(runPipeline(pipeline, { ...options(), runsDir: dir, runId }), { message: `runId "${runId}" is not file-name-safe` });
  }
  assert.equal(await exists(path.join(runsDir, 'escaped.md')), false, 'nothing written outside the runs directory');
  assert.equal(await exists(dir), false, 'and nothing inside it either: not even the directory was created');
});

test('a run whose report cannot be written still completes: the outcome stands and the failure is a warning', async () => {
  const lines: string[] = [];
  await mkdir(reportFile(runsDir, 'rp6'), { recursive: true }); // a directory sits on the report's own path
  const pipeline: Pipeline = { name: 'report-blocked', steps: [{ id: 'seed', uses: constant, params: { value: 'hi' } }] };
  const res = await runPipeline(pipeline, { ...options(lines), runId: 'rp6' });
  assert.equal(res.ok, true, 'writing the report cannot change a run outcome');
  assert.equal(res.report, undefined);
  assert.ok(lines.some((l) => /warn run report not written run=rp6 /.test(l)), lines.join('\n'));
});

test('writeReport logs a warning and returns the result unchanged when the file cannot be written', async () => {
  const lines: string[] = [];
  const blocked = path.join(runsDir, 'not-a-dir');
  await writeFile(blocked, '');
  const before = result(true, [record({})]);
  const after_ = await writeReport(blocked, before, started, flags(), createLogger((l) => lines.push(l)));
  assert.deepEqual(after_, before);
  assert.equal(after_.report, undefined);
  assert.ok(lines.some((l) => /^\S+ warn run report not written run=\S+ file=\S+ reason=/.test(l)), lines.join('\n'));
});
