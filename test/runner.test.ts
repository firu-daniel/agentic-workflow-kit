// Drives the runner with inline no-LLM steps. Run with `npm test` (node:test through tsx).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import smoke from '../pipelines/smoke.js';
import { createLogger } from '../src/log.js';
import { runPipeline } from '../src/runner.js';
import type { RunnerOptions, Sleep } from '../src/runner.js';
import { DEFAULT_RETRY, NonRetryableError, step, type LlmClient, type Pipeline, type Step } from '../src/types.js';

const noLlm: LlmClient = {
  complete: async () => {
    throw new Error('no LLM in this test');
  },
};

/** Every test checkpoints into one temp dir, never the repo's runs/. The failure cases leave files behind on
 * purpose, so every pipeline name below must be unique across tests or a later test resumes an earlier one's file. */
const runsDir = await mkdtemp(path.join(tmpdir(), 'awk-runner-'));
after(() => rm(runsDir, { recursive: true, force: true }));
const checkpointFile = (pipeline: string): string => path.join(runsDir, `${pipeline}.checkpoint.json`);
const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

/** Runner options with a capturing logger; `lines` collects every log line, `delays` the backoff waits the runner asked
 * for (never slept: every test runs on a no-op sleep, so a step left on DEFAULT_RETRY cannot stall the suite). */
function options(lines: string[] = [], fresh = false, delays: number[] = []): RunnerOptions {
  const flags = { dryRun: false, approve: false, fresh };
  const sleep: Sleep = async (ms) => {
    delays.push(ms);
  };
  return { flags, llm: noLlm, log: createLogger((l) => lines.push(l)), runsDir, sleep };
}

const constant: Step<{ value: string }, string> = {
  name: 'constant',
  async run(ctx) {
    return { output: ctx.params.value, usage: { input: 3, output: 5 } };
  },
};

const upper: Step<{ from: string }, string> = {
  name: 'upper',
  async run(ctx) {
    return { output: String(ctx.inputs[ctx.params.from]).toUpperCase() };
  },
  verify(output) {
    return output === output.toUpperCase() ? [] : ['not upper-case'];
  },
};

/** `upper` on `seed` whose pipeline rule fails with `too short`; one attempt so the case survives the retry loop. */
const tooShort = step({
  id: 'shout',
  uses: upper,
  params: { from: 'seed' },
  verify: [(o) => (o.length > 5 ? [] : ['too short'])],
  retry: { attempts: 1 },
});

test('outputs pass forward by step id and the record list has one entry per step', async () => {
  const seen: Record<string, unknown>[] = [];
  const spy: Step<Record<string, never>, string> = {
    name: 'spy',
    async run(ctx) {
      seen.push({ ...ctx.inputs });
      return { output: 'ok' };
    },
  };
  const pipeline: Pipeline = {
    name: 'forward',
    steps: [
      { id: 'seed', uses: constant, params: { value: 'hi' } },
      { id: 'shout', uses: upper, params: { from: 'seed' } },
      { id: 'look', uses: spy, params: {} },
    ],
  };

  const result = await runPipeline(pipeline, { ...options(), runId: 'r1' });

  assert.equal(result.ok, true);
  assert.equal(result.runId, 'r1');
  assert.equal(result.pipeline, 'forward');
  assert.deepEqual(seen, [{ seed: 'hi', shout: 'HI' }]);
  assert.deepEqual(
    result.records.map((r) => [r.id, r.uses, r.status, r.attempts]),
    [['seed', 'constant', 'done', 1], ['shout', 'upper', 'done', 1], ['look', 'spy', 'done', 1]],
  );
  assert.deepEqual(result.records[0].usage, { input: 3, output: 5 });
  assert.deepEqual(result.records[1].usage, { input: 0, output: 0 });
  assert.ok(result.records.every((r) => r.durationMs >= 0 && r.error === undefined));
});

test('every step attempt is one log line carrying duration and tokens', async () => {
  const lines: string[] = [];
  const pipeline: Pipeline = {
    name: 'logged',
    steps: [
      { id: 'seed', uses: constant, params: { value: 'hi' } },
      { id: 'shout', uses: upper, params: { from: 'seed' } },
    ],
  };

  await runPipeline(pipeline, { ...options(lines), runId: 'r2' });

  const stepLines = lines.filter((l) => l.includes(' info step '));
  assert.equal(stepLines.length, 2);
  assert.match(stepLines[0], /run=r2 step=seed uses=constant status=done attempt=1 ms=\d+ in=3 out=5$/);
  assert.match(stepLines[1], /run=r2 step=shout uses=upper status=done attempt=1 ms=\d+ in=0 out=0$/);
  assert.ok(lines.some((l) => l.includes('run done')));
});

test('a verify failure fails the step, stops the run and names the step in the log', async () => {
  const lines: string[] = [];
  let ranAfter = false;
  const later: Step<Record<string, never>, string> = {
    name: 'later',
    async run() {
      ranAfter = true;
      return { output: 'x' };
    },
  };
  const pipeline: Pipeline = {
    name: 'stops',
    steps: [
      { id: 'seed', uses: constant, params: { value: 'hi' } },
      tooShort,
      { id: 'never', uses: later, params: {}, retry: { attempts: 1 } },
    ],
  };

  const result = await runPipeline(pipeline, { ...options(lines), runId: 'r3' });

  assert.equal(result.ok, false);
  assert.equal(ranAfter, false);
  assert.deepEqual(
    result.records.map((r) => [r.id, r.status]),
    [['seed', 'done'], ['shout', 'failed']],
  );
  assert.equal(result.records[1].error, 'verify: too short');
  assert.ok(lines.some((l) => l.includes('warn step') && l.includes('step=shout') && l.includes('status=failed')));
  assert.ok(lines.some((l) => l.includes('error run failed') && l.includes('step=shout')));
});

test('a thrown error fails the step with the error text in the record', async () => {
  const boom: Step<Record<string, never>, string> = {
    name: 'boom',
    async run() {
      throw new Error('kaboom');
    },
  };
  const pipeline: Pipeline = { name: 'throws', steps: [{ id: 'b', uses: boom, params: {}, retry: { attempts: 1 } }] };

  const result = await runPipeline(pipeline, { ...options(), runId: 'r4' });

  assert.equal(result.ok, false);
  assert.equal(result.records[0].status, 'failed');
  assert.equal(result.records[0].error, 'kaboom');
});

test('duplicate step ids are rejected before any step runs', async () => {
  const pipeline: Pipeline = {
    name: 'dupes',
    steps: [
      { id: 'a', uses: constant, params: { value: '1' } },
      { id: 'a', uses: constant, params: { value: '2' } },
    ],
  };
  await assert.rejects(() => runPipeline(pipeline, options()), /duplicate step id "a"/);
});

test('a step verify failure and a pipeline rule failure are collected in that order', async () => {
  const picky: Step<Record<string, never>, string> = {
    name: 'picky',
    async run() {
      return { output: 'x' };
    },
    verify() {
      return ['step rule failed'];
    },
  };
  const pipeline: Pipeline = {
    name: 'collects',
    steps: [{ id: 'p', uses: picky, params: {}, verify: [() => ['pipeline rule failed']], retry: { attempts: 1 } }],
  };

  const result = await runPipeline(pipeline, { ...options(), runId: 'r5' });

  assert.equal(result.ok, false);
  assert.equal(result.records[0].error, 'verify: step rule failed; pipeline rule failed');
});

test('an artifact a step reports is surfaced on its record', async () => {
  const emit: Step<Record<string, never>, string> = {
    name: 'emit',
    async run() {
      return { output: 'written', artifact: 'out/x.md' };
    },
  };
  const pipeline: Pipeline = { name: 'emits', steps: [{ id: 'e', uses: emit, params: {} }] };

  const result = await runPipeline(pipeline, { ...options(), runId: 'r6' });

  assert.equal(result.ok, true);
  assert.equal(result.records[0].artifact, 'out/x.md');
});

test('the logger JSON-quotes a value with spaces and prints an empty value as ""', async () => {
  const lines: string[] = [];
  const pipeline: Pipeline = {
    name: 'quoted',
    steps: [
      { id: 'seed', uses: constant, params: { value: 'hi' } },
      tooShort,
    ],
  };

  await runPipeline(pipeline, { ...options(lines), runId: 'r7' });

  const failed = lines.find((l) => l.includes(' warn step '));
  assert.ok(failed?.includes('error="verify: too short"'), failed);

  const own: string[] = [];
  createLogger((l) => own.push(l)).info('m', { empty: '' });
  assert.ok(own[0].endsWith('empty=""'), own[0]);
});

/** `constant` that counts its runs, and a step that throws until `failuresLeft` reaches zero. */
function counting(): { calls: { seed: number; flaky: number }; seed: Step<{ value: string }, string>; flaky: Step<Record<string, never>, string> } {
  const calls = { seed: 0, flaky: 0 };
  let failuresLeft = 1;
  return {
    calls,
    seed: {
      name: 'constant',
      async run(ctx) {
        calls.seed += 1;
        return { output: ctx.params.value };
      },
    },
    flaky: {
      name: 'flaky',
      async run(ctx) {
        calls.flaky += 1;
        if (failuresLeft-- > 0) throw new Error('first time fails');
        return { output: `${ctx.inputs.seed}!`, artifact: 'out/flaky.txt' };
      },
    },
  };
}

test('a re-run after a failure resumes at the failed step, reusing the earlier output', async () => {
  const { calls, seed, flaky } = counting();
  const pipeline: Pipeline = {
    name: 'resume',
    steps: [
      { id: 'seed', uses: seed, params: { value: 'hi' } },
      { id: 'again', uses: flaky, params: {}, retry: { attempts: 1 } },
    ],
  };
  const file = checkpointFile('resume');

  const first = await runPipeline(pipeline, { ...options(), runId: 'r8a' });
  assert.equal(first.ok, false);
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(written.steps, [{ id: 'seed', uses: 'constant' }, { id: 'again', uses: 'flaky' }]);
  assert.deepEqual(written.completed, { seed: { output: 'hi' } });

  const lines: string[] = [];
  const second = await runPipeline(pipeline, { ...options(lines), runId: 'r8b' });

  assert.equal(second.ok, true);
  assert.deepEqual(calls, { seed: 1, flaky: 2 });
  assert.deepEqual(
    second.records.map((r) => [r.id, r.status, r.attempts, r.durationMs, r.usage]),
    [['seed', 'resumed', 0, 0, { input: 0, output: 0 }], ['again', 'done', 1, second.records[1].durationMs, { input: 0, output: 0 }]],
  );
  assert.ok(lines.some((l) => l.includes(' info checkpoint loaded ') && l.includes('completed=1')));
  assert.ok(lines.some((l) => l.includes(' info run start ') && l.endsWith('steps=2 resumed=1')));
  assert.ok(lines.some((l) => l.endsWith('run=r8b step=seed uses=constant status=resumed')));
  assert.equal(await exists(file), false, 'a completed run removes its checkpoint');
});

test('a resumed step keeps its artifact, and an undefined output still counts as completed', async () => {
  const { seed, flaky } = counting();
  let undefRuns = 0;
  const undef: Step<Record<string, never>, undefined> = {
    name: 'undef',
    async run() {
      undefRuns += 1;
      return { output: undefined };
    },
  };
  const boom: Step<Record<string, never>, string> = {
    name: 'boom',
    async run() {
      throw new Error('kaboom');
    },
  };
  const pipeline: Pipeline = {
    name: 'artifact-resume',
    steps: [
      { id: 'seed', uses: seed, params: { value: 'hi' } },
      { id: 'u', uses: undef, params: {} },
      { id: 'again', uses: flaky, params: {}, retry: { attempts: 1 } },
      { id: 'b', uses: boom, params: {}, retry: { attempts: 1 } },
    ],
  };

  await runPipeline(pipeline, { ...options(), runId: 'r9a' }); // fails at `again`
  await runPipeline(pipeline, { ...options(), runId: 'r9b' }); // `again` passes, fails at `b`
  const third = await runPipeline(pipeline, { ...options(), runId: 'r9c' });

  assert.equal(undefRuns, 1);
  assert.deepEqual(
    third.records.map((r) => [r.id, r.status, r.artifact]),
    [['seed', 'resumed', undefined], ['u', 'resumed', undefined], ['again', 'resumed', 'out/flaky.txt'], ['b', 'failed', undefined]],
  );
  assert.equal(await exists(checkpointFile('artifact-resume')), true, 'a failed run keeps its checkpoint');
});

test('--fresh deletes the checkpoint before starting so every step runs again', async () => {
  const { calls, seed, flaky } = counting();
  const pipeline: Pipeline = {
    name: 'fresh',
    steps: [
      { id: 'seed', uses: seed, params: { value: 'hi' } },
      { id: 'again', uses: flaky, params: {}, retry: { attempts: 1 } },
    ],
  };

  await runPipeline(pipeline, { ...options(), runId: 'r10a' });
  const lines: string[] = [];
  const second = await runPipeline(pipeline, { ...options(lines, true), runId: 'r10b' });

  assert.equal(second.ok, true);
  assert.deepEqual(calls, { seed: 2, flaky: 2 });
  assert.deepEqual(second.records.map((r) => r.status), ['done', 'done']);
  assert.ok(!lines.some((l) => l.includes('checkpoint')));
});

test('a checkpoint written for a different step list is ignored with a warning', async () => {
  const { calls, seed, flaky } = counting();
  const steps: Pipeline['steps'] = [
    { id: 'seed', uses: seed, params: { value: 'hi' } },
    { id: 'again', uses: flaky, params: {}, retry: { attempts: 1 } },
  ];
  const pipeline: Pipeline = { name: 'reshaped', steps };

  await runPipeline(pipeline, { ...options(), runId: 'r11a' });
  const grown: Pipeline = { name: 'reshaped', steps: [{ id: 'extra', uses: seed, params: { value: 'x' } }, ...steps] };
  const lines: string[] = [];
  const second = await runPipeline(grown, { ...options(lines), runId: 'r11b' });

  assert.equal(second.ok, true);
  assert.deepEqual(calls, { seed: 3, flaky: 2 });
  assert.deepEqual(second.records.map((r) => r.status), ['done', 'done', 'done']);
  assert.ok(lines.some((l) => l.includes(' warn checkpoint ignored ') && l.includes('reason="not a checkpoint for this step list"')));
});

test('an unparsable checkpoint file, or a parsable one with a non-object completed map, is ignored with a warning', async () => {
  const { calls, seed } = counting();
  const pipeline: Pipeline = { name: 'garbage', steps: [{ id: 'seed', uses: seed, params: { value: 'hi' } }] };
  const shape = [{ id: 'seed', uses: 'constant' }];
  const bad = ['{ not json', JSON.stringify({ pipeline: 'garbage', steps: shape, completed: [] }), JSON.stringify({ pipeline: 'garbage', steps: shape, completed: 5 })];

  for (const [i, content] of bad.entries()) {
    await writeFile(checkpointFile('garbage'), content);
    const lines: string[] = [];
    const result = await runPipeline(pipeline, { ...options(lines), runId: `r12-${i}` });
    assert.equal(result.ok, true, content);
    assert.equal(result.records[0].status, 'done', content);
    assert.ok(lines.some((l) => l.includes(' warn checkpoint ignored ')), content);
  }
  assert.equal(calls.seed, bad.length);
});

test('a step id that is an Object.prototype key is never mistaken for a completed step', async () => {
  const { calls, seed } = counting();
  const pipeline: Pipeline = {
    name: 'proto-ids',
    steps: [
      { id: 'constructor', uses: seed, params: { value: 'a' } },
      { id: '__proto__', uses: seed, params: { value: 'b' } },
      { id: 'toString', uses: seed, params: { value: 'c' } },
    ],
  };

  const result = await runPipeline(pipeline, { ...options(), runId: 'r13' });

  assert.equal(result.ok, true);
  assert.equal(calls.seed, 3);
  assert.deepEqual(result.records.map((r) => r.status), ['done', 'done', 'done']);
});

/** Records `attempt` and `previousFailures` of every call; throws `boom <attempt>` while `throwsLeft` > 0, then returns
 * 'draft' until it sees a previous failure and 'corrected' after (both verify-checked by the caller's rules). */
function selfCorrecting(throwsLeft = 0): { seen: { attempt: number; previousFailures: string[] }[]; step: Step<Record<string, never>, string> } {
  const seen: { attempt: number; previousFailures: string[] }[] = [];
  return {
    seen,
    step: {
      name: 'draft',
      async run(ctx) {
        seen.push({ attempt: ctx.attempt, previousFailures: [...ctx.previousFailures] });
        if (throwsLeft-- > 0) throw new Error(`boom ${ctx.attempt}`);
        return { output: ctx.previousFailures.length ? 'corrected' : 'draft', usage: { input: 1, output: 2 } };
      },
      verify(output) {
        return output === 'draft' ? ['still a draft'] : [];
      },
    },
  };
}

test('a step that fails verify once is retried at once with the failures in previousFailures and the run ends green', async () => {
  const lines: string[] = [];
  const delays: number[] = [];
  const { seen, step: draft } = selfCorrecting();
  const pipeline: Pipeline = {
    name: 'retries',
    steps: [{ id: 'd', uses: draft, params: {}, verify: [(o) => (o.length > 5 ? [] : ['too short'])], retry: { attempts: 2, baseDelayMs: 50 } }],
  };

  const result = await runPipeline(pipeline, { ...options(lines, false, delays), runId: 'r14' });

  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{ attempt: 1, previousFailures: [] }, { attempt: 2, previousFailures: ['still a draft', 'too short'] }]);
  assert.deepEqual(delays, [], 'a verify failure retries without backoff');
  const [record] = result.records;
  assert.deepEqual([record.status, record.attempts, record.usage, record.error], ['done', 2, { input: 2, output: 4 }, undefined]);
  const stepLines = lines.filter((l) => l.includes(' step '));
  assert.equal(stepLines.length, 2, 'one log line per attempt');
  assert.match(stepLines[0], / warn step .*status=failed attempt=1 .*error="verify: still a draft; too short"$/);
  assert.match(stepLines[1], / info step .*status=done attempt=2 /);
  assert.ok(lines.some((l) => l.endsWith(' info retry run=r14 step=d attempt=2 of=2 delayMs=0')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes(' info run done ')));
});

test('a non-retryable error ends the run after one attempt, whatever the retry policy', async () => {
  const delays: number[] = [];
  let calls = 0;
  const strict: Step<Record<string, never>, string> = {
    name: 'strict',
    async run() {
      calls += 1;
      throw new NonRetryableError('bad input');
    },
  };
  const pipeline: Pipeline = { name: 'non-retryable', steps: [{ id: 's', uses: strict, params: {}, retry: { attempts: 5, baseDelayMs: 1 } }] };

  const result = await runPipeline(pipeline, { ...options([], false, delays), runId: 'r15' });

  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
  assert.deepEqual([result.records[0].status, result.records[0].attempts, result.records[0].error], ['failed', 1, 'bad input']);
});

test('retries back off exponentially from baseDelayMs, feed the thrown error text forward and stop after the last attempt', async () => {
  const lines: string[] = [];
  const delays: number[] = [];
  const { seen, step: draft } = selfCorrecting(99);
  const pipeline: Pipeline = { name: 'exhausted', steps: [{ id: 'd', uses: draft, params: {}, retry: { attempts: 4, baseDelayMs: 10 } }] };

  const result = await runPipeline(pipeline, { ...options(lines, false, delays), runId: 'r16' });

  assert.equal(result.ok, false);
  assert.deepEqual(delays, [10, 20, 40]);
  assert.deepEqual(seen.map((s) => s.previousFailures), [[], ['boom 1'], ['boom 2'], ['boom 3']]);
  assert.deepEqual([result.records[0].status, result.records[0].attempts, result.records[0].error], ['failed', 4, 'boom 4']);
  assert.equal(lines.filter((l) => l.includes(' warn step ')).length, 4);
  assert.ok(lines.some((l) => l.includes(' error run failed ') && l.includes('step=d attempts=4 error="boom 4"')), lines.join('\n'));
});

test('only a thrown error backs off: verify failure, then a throw, then success waits once, before the third attempt', async () => {
  const lines: string[] = [];
  const delays: number[] = [];
  let calls = 0;
  const mixed: Step<Record<string, never>, string> = {
    name: 'mixed',
    async run() {
      calls += 1;
      if (calls === 2) throw new Error('flaky');
      return { output: calls === 1 ? 'draft' : 'final' };
    },
    verify(output) {
      return output === 'draft' ? ['still a draft'] : [];
    },
  };
  const pipeline: Pipeline = { name: 'mixed-retry', steps: [{ id: 'm', uses: mixed, params: {}, retry: { attempts: 3, baseDelayMs: 10 } }] };

  const result = await runPipeline(pipeline, { ...options(lines, false, delays), runId: 'r19' });

  assert.equal(result.ok, true);
  assert.deepEqual([result.records[0].status, result.records[0].attempts], ['done', 3]);
  assert.deepEqual(delays, [20], 'no wait after the verify failure; 10 * 2^(3-2) before attempt 3');
  assert.ok(lines.some((l) => l.endsWith(' info retry run=r19 step=m attempt=2 of=3 delayMs=0')), lines.join('\n'));
  assert.ok(lines.some((l) => l.endsWith(' info retry run=r19 step=m attempt=3 of=3 delayMs=20')), lines.join('\n'));
});

test('a step without retry settings gets DEFAULT_RETRY, a partial override keeps the other default, and attempts below 1 still run once', async () => {
  const { step: draft } = selfCorrecting(99);
  const defaults: number[] = [];
  const partial: number[] = [];

  const byDefault = await runPipeline({ name: 'default-retry', steps: [{ id: 'd', uses: draft, params: {} }] }, { ...options([], false, defaults), runId: 'r17a' });
  const overridden = await runPipeline({ name: 'partial-retry', steps: [{ id: 'd', uses: draft, params: {}, retry: { attempts: 2 } }] }, { ...options([], false, partial), runId: 'r17b' });

  assert.deepEqual(DEFAULT_RETRY, { attempts: 3, baseDelayMs: 1000 });
  assert.equal(byDefault.records[0].attempts, 3);
  assert.deepEqual(defaults, [1000, 2000]);
  assert.equal(overridden.records[0].attempts, 2);
  assert.deepEqual(partial, [1000]);

  const zero: number[] = [];
  const belowOne = await runPipeline({ name: 'zero-attempts', steps: [{ id: 'd', uses: draft, params: {}, retry: { attempts: 0 } }] }, { ...options([], false, zero), runId: 'r17c' });
  assert.equal(belowOne.records[0].attempts, 1);
  assert.deepEqual(zero, []);
});

test('the smoke pipeline runs green with its exclaim step retried once', async () => {
  const result = await runPipeline(smoke, { ...options(), runId: 'r18' });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.records.map((r) => [r.id, r.status, r.attempts]),
    [['seed', 'done', 1], ['shout', 'done', 1], ['exclaim', 'done', 2]],
  );
  assert.equal(await exists(checkpointFile('smoke')), false, 'a completed run removes its checkpoint');
});

/** Runner options for a dry run: the plan lines land in `out`. */
function dryOptions(out: string[], lines: string[] = [], fresh = false): RunnerOptions {
  return { ...options(lines, fresh), flags: { dryRun: true, approve: false, fresh }, out: (l) => out.push(l) };
}

test('--dry-run returns the plan, prints it, calls no step and creates nothing under runs/', async () => {
  const { calls, seed, flaky } = counting();
  const circular: { value: string; self?: unknown } = { value: 'hi' };
  circular.self = circular; // a param the run path never serializes must not crash the plan
  const pipeline: Pipeline = {
    name: 'dry',
    steps: [
      { id: 'seed', uses: seed, params: { value: 'hi' } },
      { id: 'again', uses: flaky, params: {}, verify: [() => []], retry: { attempts: 2, baseDelayMs: 5 }, gate: true },
      { id: 'shout', uses: upper, params: { from: 'seed', note: 'x'.repeat(100) }, verify: [() => [], () => []] },
      { id: 'loop', uses: constant, params: circular },
    ],
  };
  const absentRunsDir = path.join(runsDir, 'absent');
  const out: string[] = [];
  const lines: string[] = [];

  const result = await runPipeline(pipeline, { ...dryOptions(out, lines), runsDir: absentRunsDir, runId: 'r20' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.records, []);
  assert.deepEqual(calls, { seed: 0, flaky: 0 });
  assert.deepEqual(result.plan, [
    { id: 'seed', uses: 'constant', params: { value: 'hi' }, verify: { step: false, rules: 0 }, retry: DEFAULT_RETRY, gate: false, action: 'run' },
    { id: 'again', uses: 'flaky', params: {}, verify: { step: false, rules: 1 }, retry: { attempts: 2, baseDelayMs: 5 }, gate: true, action: 'gate' },
    { id: 'shout', uses: 'upper', params: { from: 'seed', note: 'x'.repeat(100) }, verify: { step: true, rules: 2 }, retry: DEFAULT_RETRY, gate: false, action: 'run' },
    { id: 'loop', uses: 'constant', params: circular, verify: { step: false, rules: 0 }, retry: DEFAULT_RETRY, gate: false, action: 'run' },
  ]);
  assert.equal(await exists(absentRunsDir), false, 'a dry run creates nothing under runs/');
  assert.deepEqual(out.slice(0, 3), [
    'dry run dry: 4 steps, no checkpoint; stops at the first gate without --approve; no step is called; retry backoff applies after a thrown error only',
    '  1. seed   run   uses=constant verify=none retry=3x1000ms params={"value":"hi"}',
    '  2. again  gate  uses=flaky verify=1 rule retry=2x5ms gate params={}',
  ]);
  assert.match(out[3], /^ {2}3\. shout {2}run {3}uses=upper verify=step\.verify\+2 rules retry=3x1000ms params=\{"from":"seed","note":"x{56}…$/);
  assert.equal(out[4], '  4. loop   run   uses=constant verify=none retry=3x1000ms params=[unprintable]');
  assert.equal(out.length, 5);
  assert.ok(lines.some((l) => l.includes(' info run start ') && l.endsWith('steps=4 resumed=0')));
  assert.ok(!lines.some((l) => l.includes('run done')));
});

test('--dry-run marks checkpointed steps as skipped and leaves the checkpoint untouched, with or without --fresh', async () => {
  const { calls, seed, flaky } = counting();
  const pipeline: Pipeline = {
    name: 'dry-resume',
    steps: [
      { id: 'seed', uses: seed, params: { value: 'hi' } },
      { id: 'again', uses: flaky, params: {}, retry: { attempts: 1 } },
    ],
  };
  const file = checkpointFile('dry-resume');
  await runPipeline(pipeline, { ...options(), runId: 'r21a' }); // fails at `again`, checkpoint holds `seed`
  const before = await readFile(file, 'utf8');

  const out: string[] = [];
  const dry = await runPipeline(pipeline, { ...dryOptions(out), runId: 'r21b' });
  const outFresh: string[] = [];
  const fresh = await runPipeline(pipeline, { ...dryOptions(outFresh, [], true), runId: 'r21c' });

  assert.deepEqual(dry.plan?.map((e) => e.action), ['skip', 'run']);
  assert.equal(out[0], `dry run dry-resume: 2 steps, 1 skipped (done in ${file}); no step is called; retry backoff applies after a thrown error only`);
  assert.match(out[1], /^ {2}1\. seed {3}skip {2}uses=constant /);
  assert.deepEqual(fresh.plan?.map((e) => e.action), ['run', 'run']);
  assert.equal(outFresh[0], 'dry run dry-resume: 2 steps, checkpoint ignored (--fresh); no step is called; retry backoff applies after a thrown error only');
  assert.equal(await readFile(file, 'utf8'), before, 'a dry run never deletes or rewrites the checkpoint');
  assert.deepEqual(calls, { seed: 1, flaky: 1 });
});

// --- the approval gate ---------------------------------------------------------------------------------------------

const reviewFile = (pipeline: string): string => path.join(runsDir, `${pipeline}.review.md`);

test('a gated step stops the run without --approve: gated record, review file, checkpoint kept, step not called', async () => {
  const { calls, seed, flaky } = counting();
  const pipeline: Pipeline = {
    name: 'gated',
    steps: [
      { id: 'seed', uses: seed, params: { value: 'hi' } },
      { id: 'again', uses: flaky, params: { from: 'seed' }, gate: true },
      { id: 'tail', uses: constant, params: { value: 'never' } },
    ],
  };
  const lines: string[] = [];

  const result = await runPipeline(pipeline, { ...options(lines), runId: 'r30' });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, { seed: 1, flaky: 0 });
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records[1], {
    id: 'again', uses: 'flaky', status: 'gated', attempts: 0, durationMs: 0, usage: { input: 0, output: 0 }, artifact: reviewFile('gated'),
  });
  assert.ok(lines.some((l) => l.includes(` warn run gated run=r30 step=again uses=flaky review=${reviewFile('gated')}`)), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('run done') || l.includes('run failed') || l.includes('gate approved')));
  const checkpoint = JSON.parse(await readFile(checkpointFile('gated'), 'utf8'));
  assert.deepEqual(Object.keys(checkpoint.completed), ['seed'], 'the checkpoint holds the completed steps only');
  const review = await readFile(reviewFile('gated'), 'utf8');
  assert.match(review, /^# Review: gated stopped before "again" \(flaky\)\n/);
  assert.match(review, /Run r30, \d{4}-\d{2}-\d{2}T[^.]+\.\d{3}Z\.\n\nStep `again` is marked `gate: true`/);
  assert.match(review, /The 1 completed step is in the checkpoint/);
  assert.match(review, /\n {4}npm run start -- --pipeline gated --approve\n/);
  assert.match(review, /## Step "again" would run with\n\n```json\n\{\n {2}"from": "seed"\n\}\n```\n/);
  assert.match(review, /## Input "seed" \(output of step "seed"\)\n\n```\nhi\n```\n/);
  assert.match(review, /## Completed steps\n\n\| # \| step \| uses \| status \| attempts \| ms \| tokens in\/out \| artifact \|\n\|---.*\n\| 1 \| seed \| constant \| done \| 1 \| \d+ \| 0\/0 \|  \|\n$/);
});

test('--approve after a gate stop resumes the completed steps, runs the gated step first and clears checkpoint and review', async () => {
  const { calls, seed, flaky } = counting();
  const pipeline: Pipeline = {
    name: 'gated-approve',
    steps: [
      { id: 'seed', uses: seed, params: { value: 'hi' } },
      { id: 'again', uses: flaky, params: {}, retry: { attempts: 2, baseDelayMs: 1 }, gate: true },
    ],
  };
  const stopped = await runPipeline(pipeline, { ...options(), runId: 'r31a' });
  assert.equal(stopped.ok, false);
  assert.equal(await exists(reviewFile('gated-approve')), true);

  const lines: string[] = [];
  const approved = await runPipeline(pipeline, { ...options(lines), flags: { dryRun: false, approve: true, fresh: false }, runId: 'r31b' });

  assert.equal(approved.ok, true, lines.join('\n'));
  assert.deepEqual(approved.records.map((r) => [r.id, r.status, r.attempts]), [['seed', 'resumed', 0], ['again', 'done', 2]]);
  assert.deepEqual(calls, { seed: 1, flaky: 2 }, 'seed is not run again; the gated step runs (and retries) under --approve');
  assert.ok(lines.some((l) => l.includes(' info gate approved run=r31b step=again')), lines.join('\n'));
  assert.equal(await exists(checkpointFile('gated-approve')), false);
  assert.equal(await exists(reviewFile('gated-approve')), false, 'a completed run removes the review file with the checkpoint');
});

test('--approve on a first run passes the gate without stopping, and --fresh removes a left-over review file', async () => {
  let failuresLeft = 2;
  const flaky: Step<Record<string, never>, string> = {
    name: 'flaky',
    async run() {
      if (failuresLeft-- > 0) throw new Error('not yet');
      return { output: 'ok' };
    },
  };
  const { calls, seed } = counting();
  const pipeline: Pipeline = {
    name: 'gated-fresh',
    steps: [
      { id: 'seed', uses: seed, params: { value: 'hi' } },
      { id: 'again', uses: flaky, params: {}, retry: { attempts: 1 }, gate: true },
    ],
  };
  const lines: string[] = [];
  const first = await runPipeline(pipeline, { ...options(lines), flags: { dryRun: false, approve: true, fresh: false }, runId: 'r32a' });
  assert.deepEqual(first.records.map((r) => r.status), ['done', 'failed'], 'the gate let flaky run; it failed its single attempt');
  assert.ok(lines.some((l) => l.includes(' info gate approved run=r32a step=again')));
  assert.ok(!lines.some((l) => l.includes('run gated')));
  assert.equal(await exists(reviewFile('gated-fresh')), false);

  const gated = await runPipeline(pipeline, { ...options(), flags: { dryRun: false, approve: false, fresh: true }, runId: 'r32b' });
  assert.deepEqual(gated.records.map((r) => r.status), ['done', 'gated']);
  assert.equal(calls.seed, 2, '--fresh ran seed again before reaching the gate');
  assert.equal(await exists(reviewFile('gated-fresh')), true);

  const dry: string[] = [];
  await runPipeline(pipeline, { ...dryOptions(dry), runId: 'r32c' });
  assert.match(dry[0], /^dry run gated-fresh: 2 steps, 1 skipped .*; stops at the first gate without --approve; /);
  assert.match(dry[2], /^ {2}2\. again  gate  /);
  const dryApproved: string[] = [];
  await runPipeline(pipeline, { ...dryOptions(dryApproved), flags: { dryRun: true, approve: true, fresh: false }, runId: 'r32d' });
  assert.doesNotMatch(dryApproved[0], /stops at the first gate/);
  assert.match(dryApproved[2], /^ {2}2\. again  run {3}uses=flaky .* gate params=/, 'the gate marker stays; the action is run');
  assert.equal(await exists(reviewFile('gated-fresh')), true, 'a dry run leaves the review file alone');

  const fresh = await runPipeline(pipeline, { ...options(), flags: { dryRun: false, approve: true, fresh: true }, runId: 'r32e' });
  assert.deepEqual(fresh.records.map((r) => r.status), ['done', 'failed'], 'the second failure: the run did not complete');
  assert.equal(await exists(reviewFile('gated-fresh')), false, '--fresh removed the review file before the run, not the completion cleanup');
  assert.equal(await exists(checkpointFile('gated-fresh')), true, 'the failed run left its checkpoint as usual');
});

test('an approved re-run drops the review file before it can go stale, even when a later step fails', async () => {
  const boom: Step<Record<string, never>, string> = {
    name: 'boom',
    async run() {
      throw new Error('tail failed');
    },
  };
  const pipeline: Pipeline = {
    name: 'gated-stale',
    steps: [
      { id: 'seed', uses: constant, params: { value: 'hi' } },
      { id: 'publish', uses: constant, params: { value: 'published' }, gate: true },
      { id: 'tail', uses: boom, params: {}, retry: { attempts: 1 } },
    ],
  };
  const stopped = await runPipeline(pipeline, { ...options(), runId: 'r33a' });
  assert.equal(stopped.ok, false);
  assert.equal(await exists(reviewFile('gated-stale')), true);

  const approved = await runPipeline(pipeline, { ...options(), flags: { dryRun: false, approve: true, fresh: false }, runId: 'r33b' });

  assert.equal(approved.ok, false);
  assert.deepEqual(approved.records.map((r) => r.status), ['resumed', 'done', 'failed']);
  assert.equal(await exists(checkpointFile('gated-stale')), true, 'the failed run keeps its checkpoint as usual');
  assert.equal(await exists(reviewFile('gated-stale')), false, 'the approved gate removed the review that asked for the approval');
});

test('a gate on the first step creates the runs directory, and its review claims no checkpoint and lists no step', async () => {
  const absentRunsDir = path.join(runsDir, 'absent-gate');
  const pipeline: Pipeline = {
    name: 'first-gate',
    steps: [{ id: 'publish', uses: constant, params: { value: 'published' }, gate: true }],
  };

  const result = await runPipeline(pipeline, { ...options(), runsDir: absentRunsDir, runId: 'r34' });

  assert.equal(result.ok, false);
  assert.deepEqual(result.records.map((r) => r.status), ['gated']);
  const file = path.join(absentRunsDir, 'first-gate.review.md');
  assert.equal(result.records[0].artifact, file);
  const review = await readFile(file, 'utf8');
  assert.match(review, /\nNo step has completed yet; nothing is in the checkpoint\.\n/);
  assert.doesNotMatch(review, /## Completed steps/);
  assert.doesNotMatch(review, /## Input /);
  assert.equal(await exists(path.join(absentRunsDir, 'first-gate.checkpoint.json')), false, 'no step completed, so nothing was saved');
});

test('a gate whose params JSON cannot serialize still stops the run: the review renders them as [unprintable]', async () => {
  const circular: { value: string; self?: unknown } = { value: 'published' };
  circular.self = circular; // params are never JSON round-tripped on the run path; the review must not be the exception
  const pipeline: Pipeline = {
    name: 'gated-circular',
    steps: [
      { id: 'seed', uses: constant, params: { value: 'hi' } },
      { id: 'publish', uses: constant, params: circular, gate: true },
    ],
  };
  const lines: string[] = [];

  const result = await runPipeline(pipeline, { ...options(lines), runId: 'r35' });

  assert.equal(result.ok, false);
  assert.deepEqual(result.records[1], {
    id: 'publish', uses: 'constant', status: 'gated', attempts: 0, durationMs: 0, usage: { input: 0, output: 0 }, artifact: reviewFile('gated-circular'),
  });
  assert.ok(lines.some((l) => l.includes(` warn run gated run=r35 step=publish uses=constant review=${reviewFile('gated-circular')}`)), lines.join('\n'));
  const review = await readFile(reviewFile('gated-circular'), 'utf8');
  assert.match(review, /## Step "publish" would run with\n\n```json\n\[unprintable\]\n```\n/);
  assert.match(review, /## Input "seed" \(output of step "seed"\)\n\n```\nhi\n```\n/);
});
