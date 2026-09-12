// Drives the command in src/cli.ts: the pieces in-process, and `src/index.ts` end to end in a child process (real
// flags, real exit codes, the real `pipelines/smoke.ts` loaded through tsx). Run with `npm test`.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPipeline, loadPipeline, parseCliArgs, PipelineError, PIPELINES_DIR, resolvePipelineFile } from '../src/cli.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = (name: string): string => path.join(root, 'test', 'fixtures', `${name}.ts`);

/** Each child process runs in its own temp cwd so its runs/ never touches the repo's; a name still resolves to the
 * package's pipelines/ directory, a path is passed absolute. The child env is the parent's with Node startup warnings
 * off (a NODE_OPTIONS warning would land on the stderr the tests match exactly), the resume fixture's variable
 * cleared, so an ambient AWK_TEST_PASS cannot make its first run succeed, AWK_LLM pinned to mock, so the machine's own
 * `claude` cannot put a run on the subscription, and ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL,
 * ANTHROPIC_BASE_URL and ANTHROPIC_LOG cleared, so an ambient credential cannot reach the real API and ambient SDK
 * debug output cannot land on the matched stdout; `env` adds per-test overrides on top.
 * `tempDirs` collects every directory the tests create — the child cwds and the fake-`claude` bin dirs — so one
 * `after` hook removes them all. */
const tempDirs: string[] = [];
after(() => Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }))));
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
async function cli(
  args: string[], cwd?: string, env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string; cwd: string }> {
  if (!cwd) {
    cwd = await mkdtemp(path.join(tmpdir(), 'awk-cli-'));
    tempDirs.push(cwd);
  }
  return new Promise((resolve) => {
    execFile(process.execPath, [tsx, path.join(root, 'src', 'index.ts'), ...args], { cwd, env: { ...process.env, NODE_OPTIONS: '--no-warnings', AWK_TEST_PASS: '', AWK_LLM: 'mock', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_MODEL: '', ANTHROPIC_BASE_URL: '', ANTHROPIC_LOG: '', ...env } }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? -1 : 0;
      resolve({ code, stdout, stderr, cwd: cwd as string });
    });
  });
}
/** The runs/ listing, sorted, with every per-run report (`<timestamp>.md`) shown as `<report>`: one per run made in
 * that cwd, since the runner never removes them. */
const listRuns = (cwd: string): Promise<string[]> => readdir(path.join(cwd, 'runs'))
  .then((names) => names.map((n) => (REPORT.test(n) ? '<report>' : n)).sort())
  .catch(() => ['<no runs dir>']);
const REPORT = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.md$/;
/** The `; report runs/<timestamp>.md` tail every summary carries. */
const REPORT_TAIL = String.raw`; report runs\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.md`;

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

test('`--pipeline smoke` runs green from any cwd: exit 0, one summary line on stdout, log on stderr, no checkpoint left, the report kept and readable', async () => {
  const run = await cli(['--pipeline', 'smoke']);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`^run \\S+ ok: smoke, 3 steps${REPORT_TAIL}\\n$`));
  assert.match(run.stderr, /info step .* step=exclaim uses=exclaim status=done attempt=2/);
  assert.match(run.stderr, /info run done .* pipeline=smoke steps=3/);
  assert.deepEqual(await listRuns(run.cwd), ['<report>'], 'no checkpoint left; the report stays');
  const file = /report (runs\/\S+\.md)\n$/.exec(run.stdout)?.[1];
  assert.ok(file, 'the summary names the report');
  const report = await readFile(path.join(run.cwd, file), 'utf8');
  assert.match(report, /^# Run \S+: smoke ok\n/);
  assert.match(report, /\n\| 3 \| exclaim \| exclaim \| done \| 2 \| \d+ \| 0\/0 \|  \|  \|\n/, 'the retried step shows 2 attempts');
  assert.match(report, /\nArtifact: none\n$/);
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
  assert.match(run.stderr, new RegExp(`^error: run \\S+ failed at step "boom" \\(bomb\\) after 1 attempt: the fuse was lit${REPORT_TAIL}\\n$`, 'm'));
  assert.deepEqual(await listRuns(run.cwd), ['<report>', 'cli-failing.checkpoint.json']);
  const dry = await cli(['--pipeline', fixture('failing'), '--dry-run'], run.cwd);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /^dry run cli-failing: 2 steps, 1 skipped \(done in runs\/cli-failing.checkpoint.json\)/);
  assert.match(dry.stdout, /1\. seed  skip/);
  assert.match(dry.stdout, /2\. boom  run/);
  const fresh = await cli(['--pipeline', fixture('failing'), '--dry-run', '--fresh'], run.cwd);
  assert.match(fresh.stdout, /^dry run cli-failing: 2 steps, checkpoint ignored \(--fresh\)/);
  assert.deepEqual(await listRuns(run.cwd), ['<report>', 'cli-failing.checkpoint.json'], 'a dry run writes no report');
});

test('a re-run resumes the checkpointed step: status=resumed on stderr, the resumed count in the summary, runs/ cleared', async () => {
  const first = await cli(['--pipeline', fixture('resumable')]);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /failed at step "flaky" \(flaky\) after 1 attempt: AWK_TEST_PASS is not set/);
  assert.deepEqual(await listRuns(first.cwd), ['<report>', 'cli-resumable.checkpoint.json']);
  const again = await cli(['--pipeline', fixture('resumable')], first.cwd, { AWK_TEST_PASS: '1' });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stderr, /info step .* step=seed uses=constant status=resumed/);
  assert.match(again.stdout, new RegExp(`^run \\S+ ok: cli-resumable, 3 steps \\(1 resumed\\)${REPORT_TAIL}\\n$`));
  assert.deepEqual(await listRuns(first.cwd), ['<report>', '<report>'], 'the checkpoint is gone; both runs left their report');
});

test('a gated step exits 3 with the review file named on stdout; the same command with --approve resumes and completes', async () => {
  const run = await cli(['--pipeline', fixture('gated')]);
  assert.equal(run.code, 3, run.stderr);
  assert.match(run.stdout, new RegExp(`^run \\S+ gated: cli-gated stopped before step "publish" \\(constant\\); review runs/cli-gated\\.review\\.md, then re-run with --approve${REPORT_TAIL}\\n$`));
  assert.match(run.stderr, /warn run gated .* step=publish uses=constant review=runs\/cli-gated\.review\.md/);
  assert.doesNotMatch(run.stderr, /^error:/m);
  assert.deepEqual(await listRuns(run.cwd), ['<report>', 'cli-gated.checkpoint.json', 'cli-gated.review.md']);
  const review = await readFile(path.join(run.cwd, 'runs', 'cli-gated.review.md'), 'utf8');
  assert.match(review, /^# Review: cli-gated stopped before "publish" \(constant\)\n/);
  assert.match(review, /## Input "seed" \(output of step "seed"\)\n\n```\nok\n```\n/);
  const dry = await cli(['--pipeline', fixture('gated'), '--dry-run'], run.cwd);
  assert.match(dry.stdout, /^dry run cli-gated: 3 steps, 1 skipped \(done in runs\/cli-gated\.checkpoint\.json\); stops at the first gate without --approve; /);
  assert.match(dry.stdout, /2\. publish  gate  /);
  const again = await cli(['--pipeline', fixture('gated'), '--approve'], run.cwd);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stderr, /info step .* step=seed uses=constant status=resumed/);
  assert.match(again.stderr, /info gate approved .* step=publish/);
  assert.match(again.stdout, new RegExp(`^run \\S+ ok: cli-gated, 3 steps \\(1 resumed\\)${REPORT_TAIL}\\n$`));
  assert.deepEqual(await listRuns(run.cwd), ['<report>', '<report>'], 'the checkpoint and the review file are both gone');
});

// --- the LLM slot, end to end --------------------------------------------------------------------------------------

test('AWK_LLM=mock runs an LLM step green on the mock: mode line, llm line and real in=/out= on the step line', async () => {
  const run = await cli(['--pipeline', fixture('ask')]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`^run \\S+ ok: cli-ask, 1 step${REPORT_TAIL}\\n$`));
  assert.match(run.stderr, /info llm mode mode=mock reason="AWK_LLM=mock"/);
  assert.match(run.stderr, /info llm model=mock ms=0 in=11 out=3 stop=end_turn/);
  assert.match(run.stderr, /info step .* step=ask uses=ask status=done attempt=1 ms=\d+ in=11 out=3/);
});

/** A stand-in for api.anthropic.com: answers POST /v1/messages with a Messages-API body when the key is `good`, echoing
 * the requested model, with the API's 401 body otherwise, and with a 400 body when the request is not JSON (an error an
 * assertion can read, rather than a throw out of an http callback). The request is recorded with its metadata beside
 * the parsed body, not merged into it. The real SDK talks to it through ANTHROPIC_BASE_URL. */
interface StubRequest { url?: string; key?: string | string[]; body: Record<string, unknown> }
async function stubApi(): Promise<{ server: Server; url: string; bodies: StubRequest[] }> {
  const bodies: StubRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `stub: body is not JSON: ${String(err)}` } }));
        return;
      }
      bodies.push({ url: req.url, key: req.headers['x-api-key'], body });
      if (req.headers['x-api-key'] !== 'good') {
        res.statusCode = 401;
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        return;
      }
      res.end(JSON.stringify({
        id: 'msg_stub', type: 'message', role: 'assistant', model: body.model, container: null,
        content: [{ type: 'text', text: 'FORTY-TWO', citations: null }], stop_reason: 'end_turn', stop_details: null, stop_sequence: null,
        usage: { input_tokens: 21, output_tokens: 4, cache_creation_input_tokens: null, cache_read_input_tokens: null, cache_creation: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

test('AWK_LLM=anthropic calls the real SDK: the request carries the env model, and a 401 fails the step after one attempt', async () => {
  const api = await stubApi();
  try {
    const ok = await cli(['--pipeline', fixture('ask')], undefined, { AWK_LLM: 'anthropic', ANTHROPIC_API_KEY: 'good', ANTHROPIC_BASE_URL: api.url, ANTHROPIC_MODEL: 'claude-opus-5' });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stderr, /info llm mode mode=anthropic reason="AWK_LLM=anthropic" model=claude-opus-5/);
    assert.match(ok.stderr, /info llm model=claude-opus-5 ms=\d+ in=21 out=4 stop=end_turn/);
    assert.match(ok.stderr, /info step .* step=ask uses=ask status=done attempt=1 ms=\d+ in=21 out=4/);
    assert.deepEqual(api.bodies, [{
      url: '/v1/messages', key: 'good', body: {
        model: 'claude-opus-5', max_tokens: 64, system: 'Answer in one word.',
        messages: [{ role: 'user', content: 'What is six times seven?' }],
      },
    }]);
    const denied = await cli(['--pipeline', fixture('ask')], undefined, { AWK_LLM: 'anthropic', ANTHROPIC_API_KEY: 'bad', ANTHROPIC_BASE_URL: api.url });
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /info llm mode mode=anthropic reason="AWK_LLM=anthropic" model=claude-sonnet-5/);
    assert.match(denied.stderr, /^error: run \S+ failed at step "ask" \(ask\) after 1 attempt: anthropic: 401 .*invalid x-api-key/m);
    assert.equal(api.bodies.length, 2);
  } finally {
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
  }
});

test('an AWK_LLM value that is not a mode exits 2 naming it, before any step runs', async () => {
  const run = await cli(['--pipeline', fixture('ask')], undefined, { AWK_LLM: 'openai' });
  assert.equal(run.code, 2);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'error: AWK_LLM="openai" is not a mode: expected one of claude-code, anthropic, mock\n');
});

test('AWK_LLM=claude-code with no claude on PATH exits 2 saying so, before any step runs', async () => {
  // A PATH of one empty directory: the child itself needs no PATH lookup, being spawned by absolute path
  // (process.execPath), so nothing but the `claude` probe is affected.
  const empty = await mkdtemp(path.join(tmpdir(), 'awk-empty-path-'));
  tempDirs.push(empty);
  const run = await cli(['--pipeline', fixture('ask')], undefined, { AWK_LLM: 'claude-code', PATH: empty });
  assert.equal(run.code, 2);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'error: AWK_LLM=claude-code but no executable `claude` on PATH: install the Claude Code CLI or set AWK_LLM=anthropic|mock\n');
});

/** A stand-in for the Claude Code CLI: a `claude` shell script first on PATH that records its argv and stdin to files
 * beside it and prints the canned result JSON in `$AWK_FAKE_CLAUDE_RESULT`, exiting with `$AWK_FAKE_CLAUDE_EXIT`. */
async function fakeClaude(): Promise<{ bin: string; argv: () => Promise<string[]>; stdin: () => Promise<string> }> {
  const bin = await mkdtemp(path.join(tmpdir(), 'awk-fake-claude-'));
  tempDirs.push(bin);
  const script = `#!/bin/sh
: > "$0.argv"
for a in "$@"; do printf '%s\\n' "$a" >> "$0.argv"; done
cat > "$0.stdin"
printf '%s' "$AWK_FAKE_CLAUDE_RESULT"
exit "\${AWK_FAKE_CLAUDE_EXIT:-0}"
`;
  await writeFile(path.join(bin, 'claude'), script, { mode: 0o755 });
  const read = (suffix: string) => readFile(path.join(bin, `claude${suffix}`), 'utf8');
  return { bin, argv: async () => (await read('.argv')).split('\n').slice(0, -1), stdin: () => read('.stdin') };
}

const canned = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', api_error_status: null, total_cost_usd: 0.0028,
  usage: { input_tokens: 880, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, result: 'FORTY-TWO',
  ...overrides,
});

test('AWK_LLM=claude-code spawns `claude` from PATH: headless flags, the env model, the system prompt as a flag, the prompt on stdin', async () => {
  const fake = await fakeClaude();
  const env = { AWK_LLM: 'claude-code', PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ''}`, ANTHROPIC_MODEL: 'claude-opus-5', AWK_FAKE_CLAUDE_RESULT: canned() };
  const run = await cli(['--pipeline', fixture('ask')], undefined, env);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`^run \\S+ ok: cli-ask, 1 step${REPORT_TAIL}\\n$`));
  assert.match(run.stderr, /info llm mode mode=claude-code reason="AWK_LLM=claude-code" model=claude-opus-5/);
  assert.match(run.stderr, /info llm model=claude-opus-5 ms=\d+ in=880 out=7 stop=end_turn cost=0\.0028/);
  assert.match(run.stderr, /info step .* step=ask uses=ask status=done attempt=1 ms=\d+ in=880 out=7/);
  assert.deepEqual(await fake.argv(), [
    '-p', '--output-format', 'json', '--model', 'claude-opus-5', '--tools', '', '--max-turns', '1',
    '--no-session-persistence', '--safe-mode', '--strict-mcp-config', '--system-prompt', 'Answer in one word.',
  ]);
  assert.equal(await fake.stdin(), 'What is six times seven?');
});

test('unset AWK_LLM with no key picks claude-code when `claude` is on PATH; a CLI API-status error fails the step after one attempt', async () => {
  const fake = await fakeClaude();
  const result = canned({ is_error: true, api_error_status: 404, result: "There's an issue with the selected model (claude-sonnet-5).", total_cost_usd: 0 });
  const env = { AWK_LLM: '', PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ''}`, AWK_FAKE_CLAUDE_RESULT: result, AWK_FAKE_CLAUDE_EXIT: '1' };
  const run = await cli(['--pipeline', fixture('ask')], undefined, env);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /info llm mode mode=claude-code reason="claude on PATH" model=claude-sonnet-5/);
  assert.match(run.stderr, new RegExp(`^error: run \\S+ failed at step "ask" \\(ask\\) after 1 attempt: claude-code: exit 1, api status 404: There's an issue with the selected model \\(claude-sonnet-5\\)\\.${REPORT_TAIL}\\n$`, 'm'));
});
