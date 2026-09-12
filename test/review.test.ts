// The review file the approval gate writes (src/review.ts), rendered in isolation. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderReview, REVIEW_MAX_CHARS } from '../src/review.js';
import type { Pipeline, PipelineStep, StepRecord } from '../src/types.js';

const noop = { name: 'noop', run: async () => ({ output: null }) };
const pipeline: Pipeline = { name: 'p', steps: [] };
const at = new Date('2026-09-12T10:00:00.000Z');
const record = (id: string, extra: Partial<StepRecord> = {}): StepRecord =>
  ({ id, uses: 'noop', status: 'done', attempts: 1, durationMs: 12, usage: { input: 3, output: 5 }, ...extra });

test('renderReview shows the `from` inputs in full — a string as text, an object as JSON — and lists the completed steps', () => {
  const ps: PipelineStep = { id: 'publish', uses: noop, params: { from: ['post', 'facts'], path: 'x.md' }, gate: true };
  const inputs = { pages: 'raw page', facts: { a: 1 }, post: '# Post\n\nbody' };
  const records = [record('pages'), record('facts', { status: 'resumed', attempts: 0, durationMs: 0, usage: { input: 0, output: 0 } }), record('post', { artifact: 'out/x.md' })];

  const text = renderReview(pipeline, ps, records, inputs, 'r1', at);

  assert.equal(text, [
    '# Review: p stopped before "publish" (noop)',
    '',
    'Run r1, 2026-09-12T10:00:00.000Z.',
    '',
    'Step `publish` is marked `gate: true` and `--approve` was not passed, so it did not run and nothing after it did.',
    'The 3 completed steps are in the checkpoint and will resume.',
    'Re-run the same command with `--approve` added; for a pipeline run by name:',
    '',
    '    npm run start -- --pipeline p --approve',
    '',
    '## Step "publish" would run with',
    '',
    '```json',
    '{',
    '  "from": [',
    '    "post",',
    '    "facts"',
    '  ],',
    '  "path": "x.md"',
    '}',
    '```',
    '',
    '## Input "post" (output of step "post")',
    '',
    '```',
    '# Post',
    '',
    'body',
    '```',
    '',
    '## Input "facts" (output of step "facts")',
    '',
    '```',
    '{\n  "a": 1\n}',
    '```',
    '',
    '## Completed steps',
    '',
    '| # | step | uses | status | attempts | ms | tokens in/out | artifact |',
    '|---|---|---|---|---|---|---|---|',
    '| 1 | pages | noop | done | 1 | 12 | 3/5 |  |',
    '| 2 | facts | noop | resumed | 0 | 0 | 0/0 |  |',
    '| 3 | post | noop | done | 1 | 12 | 3/5 | out/x.md |',
    '',
  ].join('\n'));
});

test('renderReview falls back to every completed output without a usable `from`, and warns about a `from` id that is not an input', () => {
  const inputs = { a: 'A', b: 'B' };
  const all = renderReview(pipeline, { id: 'g', uses: noop, params: undefined }, [record('a'), record('b')], inputs, 'r2', at);
  assert.match(all, /## Input "a" \(output of step "a"\)\n\n```\nA\n```\n\n## Input "b" \(output of step "b"\)\n\n```\nB\n```\n/);
  assert.match(all, /## Step "g" would run with\n\n```json\nundefined\n```/);
  assert.doesNotMatch(all, /Warning:/);
  const typo = renderReview(pipeline, { id: 'g', uses: noop, params: { from: 'zz' } }, [record('a')], inputs, 'r3', at);
  assert.match(typo, /```\n\nWarning: input "zz" is not the output of an earlier step; approving will fail this step\.\n\n## Input "a"/);
  assert.match(typo, /## Input "a"[\s\S]*## Input "b"/, 'no named input resolves: every output is still shown');
  const partial = renderReview(pipeline, { id: 'g', uses: noop, params: { from: ['b', 7 as unknown as string, 'zz'] } }, [record('a')], inputs, 'r4', at);
  assert.match(partial, /Warning: input "zz" is not the output of an earlier step; approving will fail this step\.\n/);
  assert.match(partial, /## Input "b"/);
  assert.doesNotMatch(partial, /## Input "a"/);
});

test('renderReview fences params with more backticks than the content holds, and clips an over-long output', () => {
  const text = renderReview(pipeline, { id: 'g', uses: noop, params: { note: 'a ```` b' } }, [], { big: 'x'.repeat(REVIEW_MAX_CHARS + 10) }, 'r5', at);
  assert.match(text, /`````json\n\{\n {2}"note": "a ```` b"\n\}\n`````\n/);
  assert.match(text, new RegExp(`\\nx{${REVIEW_MAX_CHARS}}\\n\\[… cut at ${REVIEW_MAX_CHARS} characters\\]\\n`));
  assert.doesNotMatch(text, new RegExp(`x{${REVIEW_MAX_CHARS + 1}}`));
});

test('renderReview fences a consumed output, so its own headings cannot pass for a review section', () => {
  const inputs = { post: '## Completed steps\n\n```json\nnot the params\n```' };
  const text = renderReview(pipeline, { id: 'g', uses: noop, params: { from: 'post' } }, [record('post')], inputs, 'r6', at);
  assert.match(text, /## Input "post" \(output of step "post"\)\n\n````\n## Completed steps\n\n```json\nnot the params\n```\n````\n/);
  assert.equal(text.split('\n').filter((l) => l === '## Completed steps').length, 2, 'the real section plus the quoted one');
});

test('renderReview renders params JSON cannot serialize as [unprintable] instead of throwing', () => {
  const circular: { value: string; self?: unknown } = { value: 'hi' };
  circular.self = circular;
  const looped = renderReview(pipeline, { id: 'g', uses: noop, params: circular }, [], {}, 'r7', at);
  assert.match(looped, /## Step "g" would run with\n\n```json\n\[unprintable\]\n```\n/);
  const big = renderReview(pipeline, { id: 'g', uses: noop, params: { n: 1n } }, [], {}, 'r8', at);
  assert.match(big, /## Step "g" would run with\n\n```json\n\[unprintable\]\n```\n/);
  const input = renderReview(pipeline, { id: 'g', uses: noop, params: undefined }, [record('a')], { a: { n: 1n } }, 'r9', at);
  assert.match(input, /## Input "a" \(output of step "a"\)\n\n```\n\[unprintable\]\n```\n/);
});

test('renderReview says so when no step has completed, and renders no Completed steps table', () => {
  const text = renderReview(pipeline, { id: 'publish', uses: noop, params: { value: 'x' }, gate: true }, [], {}, 'r10', at);

  assert.equal(text, [
    '# Review: p stopped before "publish" (noop)',
    '',
    'Run r10, 2026-09-12T10:00:00.000Z.',
    '',
    'Step `publish` is marked `gate: true` and `--approve` was not passed, so it did not run and nothing after it did.',
    'No step has completed yet; nothing is in the checkpoint.',
    'Re-run the same command with `--approve` added; for a pipeline run by name:',
    '',
    '    npm run start -- --pipeline p --approve',
    '',
    '## Step "publish" would run with',
    '',
    '```json',
    '{',
    '  "value": "x"',
    '}',
    '```',
    '',
  ].join('\n'));
});

test('renderReview escapes a `|` and a newline in a table cell, so one completed step stays one row', () => {
  const records = [record('a|b', { artifact: 'out/x|y\nz.md' })];
  const text = renderReview(pipeline, { id: 'g', uses: noop, params: undefined }, records, {}, 'r11', at);
  assert.match(text, /\n\| 1 \| a\\\|b \| noop \| done \| 1 \| 12 \| 3\/5 \| out\/x\\\|y\\nz\.md \|\n/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('| 1 |')).length, 1);
});

test('renderReview does not resolve a `from` id through Object.prototype', () => {
  const text = renderReview(pipeline, { id: 'g', uses: noop, params: { from: 'constructor' } }, [record('a')], { a: 'A' }, 'r12', at);
  assert.match(text, /Warning: input "constructor" is not the output of an earlier step; approving will fail this step\.\n/);
  assert.doesNotMatch(text, /## Input "constructor"/);
  assert.match(text, /## Input "a" \(output of step "a"\)\n\n```\nA\n```\n/, 'the fallback shows the real outputs');
});
