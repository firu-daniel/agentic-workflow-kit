// Drives the command in src/cli.ts: the pieces in-process, and `src/index.ts` end to end in a child process (real
// flags, real exit codes, the real `pipelines/smoke.ts` loaded through tsx). Run with `npm test`.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPipeline, loadPipeline, parseCliArgs, PipelineError, PIPELINES_DIR, resolvePipelineFile } from '../src/cli.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = (name: string): string => path.join(root, 'test', 'fixtures', `${name}.ts`);

/** Each child process runs in its own temp cwd so its runs/ never touches the repo's; a name still resolves to the
 * package's pipelines/ directory, a path is passed absolute. The child env is the parent's with Node startup warnings
 * off (a NODE_OPTIONS warning would land on the stderr the tests match exactly) and the resume fixture's variable
 * cleared, so an ambient AWK_TEST_PASS cannot make its first run succeed; `env` adds per-test overrides on top. */
const cwds: string[] = [];
after(() => Promise.all(cwds.map((d) => rm(d, { recursive: true, force: true }))));
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
async function cli(
  args: string[], cwd?: string, env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string; cwd: string }> {
  if (!cwd) {
    cwd = await mkdtemp(path.join(tmpdir(), 'awk-cli-'));
    cwds.push(cwd);
  }
  return new Promise((resolve) => {
    execFile(process.execPath, [tsx, path.join(root, 'src', 'index.ts'), ...args], { cwd, env: { ...process.env, NODE_OPTIONS: '--no-warnings', AWK_TEST_PASS: '', ...env } }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? -1 : 0;
      resolve({ code, stdout, stderr, cwd: cwd as string });
    });
  });
}
const listRuns = (cwd: string): Promise<string[]> => readdir(path.join(cwd, 'runs')).catch(() => ['<no runs dir>']);

// --- flags -------------------------------------------------------------------------------------------------------

test('parseCliArgs reads the four flags and defaults the rest to false', () => {
  assert.deepEqual(parseCliArgs(['--pipeline', 'smoke']), {
    pipeline: 'smoke', help: false, flags: { dryRun: false, approve: false, fresh: false },
  });
  assert.deepEqual(parseCliArgs(['--dry-run', '--pipeline=x', '--approve', '--fresh', '-h']), {
    pipeline: 'x', help: true, flags: { dryRun: true, approve: true, fresh: true },
  });
});

test('parseCliArgs rejects an unknown flag, a positional argument and --pipeline without a value', () => {
  assert.throws(() => parseCliArgs(['--bogus']), /Unknown option '--bogus'/);
  assert.throws(() => parseCliArgs(['smoke']), /Unexpected argument 'smoke'/);
  assert.throws(() => parseCliArgs(['--pipeline']), /argument missing/);
  assert.throws(() => parseCliArgs(['--pipeline', '--dry-run']), /ambiguous/);
});

// --- loading -----------------------------------------------------------------------------------------------------

test('a name resolves under the package pipelines/ directory, a path against the cwd', () => {
  assert.equal(resolvePipelineFile('smoke'), path.join(PIPELINES_DIR, 'smoke.ts'));
  assert.equal(resolvePipelineFile('./x/y.ts'), path.resolve('x/y.ts'));
  assert.equal(resolvePipelineFile('/abs/z.ts'), '/abs/z.ts');
});

test('loadPipeline returns the smoke pipeline by name and by path', async () => {
  const byName = await loadPipeline('smoke');
  assert.equal(byName.pipeline.name, 'smoke');
  assert.deepEqual(byName.pipeline.steps.map((s) => s.id), ['seed', 'shout', 'exclaim']);
  const byPath = await loadPipeline(path.join(root, 'pipelines', 'smoke.ts'));
  assert.equal(byPath.file, byName.file);
});

test('loadPipeline names the expected path for an unknown pipeline, with a hint when .ts was appended', async () => {
  await assert.rejects(loadPipeline('nope'), (err: unknown) => {
    assert.ok(err instanceof PipelineError);
    assert.equal(err.message, `pipeline "nope" not found: expected ${path.join(PIPELINES_DIR, 'nope.ts')}`);
    return true;
  });
  await assert.rejects(loadPipeline('smoke.ts'), /pass the name without \.ts, or a path containing "\/"/);
  await assert.rejects(loadPipeline(path.join(root, 'pipelines')), /^PipelineError: pipeline ".*" is not a file: /);
});

test('loadPipeline reports a file that throws while importing, and a default export of the wrong shape', async () => {
  await assert.rejects(loadPipeline(fixture('throws-on-load')), (err: unknown) => {
    assert.ok(err instanceof PipelineError);
    assert.equal(err.message, `${fixture('throws-on-load')}: failed to load: PIPELINE_SECRET is not set`);
    assert.ok(err.cause instanceof Error);
    return true;
  });
  await assert.rejects(loadPipeline(fixture('no-steps')), (err: unknown) => {
    assert.ok(err instanceof PipelineError);
    assert.equal(err.message, `${fixture('no-steps')}: steps must be an array of steps`);
    return true;
  });
});

test('checkPipeline names the first offending field', () => {
  const run = async () => ({ output: 1 });
  const ok = { name: 'ok', steps: [{ id: 'a', uses: { name: 'x', run }, params: 1 }] };
  assert.equal(checkPipeline(ok, 'f.ts'), ok);
  const field = (value: unknown): string => {
    try {
      checkPipeline(value, 'f.ts');
    } catch (err) {
      assert.ok(err instanceof PipelineError);
      return err.message.replace(/^f\.ts: /, '').replace(/ (must|is|").*$/, '');
    }
    return 'no error';
  };
  const withStep = (s: unknown) => ({ name: 'ok', steps: [ok.steps[0], s] });
  assert.equal(field(undefined), 'default export');
  assert.equal(field([]), 'default export');
  assert.equal(field({ steps: [] }), 'name');
  assert.equal(field({ name: '../escape', steps: [] }), 'name');
  assert.equal(field({ name: 'ok', steps: {} }), 'steps');
  assert.equal(field(withStep('seed')), 'steps[1]');
  assert.equal(field(withStep({ uses: ok.steps[0].uses })), 'steps[1].id');
  assert.equal(field(withStep({ id: 'a', uses: ok.steps[0].uses })), 'steps[1].id');
  assert.equal(field(withStep({ id: 'b', uses: ok.steps[0].uses })), 'steps[1].params');
  assert.equal(field(withStep({ id: 'b', params: 1, uses: { name: 'x' } })), 'steps[1].uses');
  assert.equal(field(withStep({ id: 'b', params: 1, uses: { name: 'x', run, verify: 1 } })), 'steps[1].uses.verify');
  assert.equal(field(withStep({ id: 'b', params: 1, uses: ok.steps[0].uses, verify: [1] })), 'steps[1].verify');
  assert.equal(field(withStep({ id: 'b', params: 1, uses: ok.steps[0].uses, retry: 3 })), 'steps[1].retry');
  assert.equal(field(withStep({ id: 'b', params: 1, uses: ok.steps[0].uses, retry: { attempts: '3' } })), 'steps[1].retry.attempts');
  assert.equal(field(withStep({ id: 'b', params: 1, uses: ok.steps[0].uses, gate: 'yes' })), 'steps[1].gate');
  assert.equal(field(withStep({ id: 'b', params: undefined, uses: ok.steps[0].uses, retry: { attempts: undefined }, gate: true })), 'no error');
});

// --- the command, end to end -------------------------------------------------------------------------------------

test('--help exits 0 with the usage on stdout; no --pipeline and an unknown flag exit 2 with the usage on stderr', async () => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: npm run start -- --pipeline <name>/);
  const none = await cli([]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /^error: --pipeline <name> is required\n\nUsage:/);
  const bogus = await cli(['--pipeline', 'smoke', '--bogus']);
  assert.equal(bogus.code, 2);
  assert.match(bogus.stderr, /^error: Unknown option '--bogus'\n\nUsage:/);
});

test('an unknown pipeline and a malformed pipeline file exit 2 naming the path and the field', async () => {
  const unknown = await cli(['--pipeline', 'nope']);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stderr, `error: pipeline "nope" not found: expected ${path.join(PIPELINES_DIR, 'nope.ts')}\n`);
  const malformed = await cli(['--pipeline', fixture('no-steps')]);
  assert.equal(malformed.code, 2);
  assert.equal(malformed.stderr, `error: ${fixture('no-steps')}: steps must be an array of steps\n`);
});

test('`--pipeline smoke` runs green from any cwd: exit 0, one summary line on stdout, log on stderr, no checkpoint left', async () => {
  const run = await cli(['--pipeline', 'smoke']);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^run \S+ ok: smoke, 3 steps\n$/);
  assert.match(run.stderr, /info step .* step=exclaim uses=exclaim status=done attempt=2/);
  assert.match(run.stderr, /info run done .* pipeline=smoke steps=3/);
  assert.deepEqual(await listRuns(run.cwd), []);
});

test('`--pipeline smoke --dry-run` prints the plan on stdout, exits 0 and creates nothing', async () => {
  const dry = await cli(['--pipeline', 'smoke', '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  const lines = dry.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^dry run smoke: 3 steps, no checkpoint; no step is called/);
  assert.match(lines[1], /^ {2}1\. seed {5}run {3}uses=constant /);
  assert.doesNotMatch(dry.stderr, /info step/);
  assert.deepEqual(await listRuns(dry.cwd), ['<no runs dir>']);
});

test('a failing step exits 1 naming the step; the checkpoint it leaves makes the next dry run skip the done step', async () => {
  const run = await cli(['--pipeline', fixture('failing')]);
  assert.equal(run.code, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /^error: run \S+ failed at step "boom" \(bomb\) after 1 attempt: the fuse was lit\n$/m);
  assert.deepEqual(await listRuns(run.cwd), ['cli-failing.checkpoint.json']);
  const dry = await cli(['--pipeline', fixture('failing'), '--dry-run'], run.cwd);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /^dry run cli-failing: 2 steps, 1 skipped \(done in runs\/cli-failing.checkpoint.json\)/);
  assert.match(dry.stdout, /1\. seed  skip/);
  assert.match(dry.stdout, /2\. boom  run/);
  const fresh = await cli(['--pipeline', fixture('failing'), '--dry-run', '--fresh'], run.cwd);
  assert.match(fresh.stdout, /^dry run cli-failing: 2 steps, checkpoint ignored \(--fresh\)/);
  assert.deepEqual(await listRuns(run.cwd), ['cli-failing.checkpoint.json']);
});

test('a re-run resumes the checkpointed step: status=resumed on stderr, the resumed count in the summary, runs/ cleared', async () => {
  const first = await cli(['--pipeline', fixture('resumable')]);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /failed at step "flaky" \(flaky\) after 1 attempt: AWK_TEST_PASS is not set/);
  assert.deepEqual(await listRuns(first.cwd), ['cli-resumable.checkpoint.json']);
  const again = await cli(['--pipeline', fixture('resumable')], first.cwd, { AWK_TEST_PASS: '1' });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stderr, /info step .* step=seed uses=constant status=resumed/);
  assert.match(again.stdout, /^run \S+ ok: cli-resumable, 3 steps \(1 resumed\)\n$/);
  assert.deepEqual(await listRuns(first.cwd), []);
});
