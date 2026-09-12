// Drives src/llm.ts: the selector, the offline mock, the Anthropic implementation against a fake SDK client (no
// network) and the Claude Code implementation against a fake exec (no process). The CLI tests run the real SDK against
// a local stand-in server and the real spawn against a fake `claude` script. Run with `npm test`.
import Anthropic, { RetryableError } from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { anthropicLlm, claudeCodeLlm, claudeOnPath, createLlm, defaultClaudeExec, DEFAULT_MAX_TOKENS, DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT, EXEC_TIMEOUT_MS, LLM_MODES, LlmModeError, MOCK_MODEL, mockLlm, type ClaudeExec, type MessagesApi } from '../src/llm.js';
import { createLogger } from '../src/log.js';
import { NonRetryableError } from '../src/types.js';

const capture = (): { lines: string[]; log: ReturnType<typeof createLogger> } => {
  const lines: string[] = [];
  return { lines, log: createLogger((l) => lines.push(l)) };
};

/** A complete SDK Message with the fields the client reads overridable. */
function message(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    container: null,
    content: [{ type: 'text', text: 'pong', citations: null }],
    stop_reason: 'end_turn',
    stop_details: null,
    stop_sequence: null,
    usage: {
      input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: null, cache_read_input_tokens: null,
      cache_creation: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null,
    },
    ...overrides,
  };
}

/** A fake client that records every request and answers from a queue of messages or errors. */
function fakeClient(answers: (Anthropic.Message | Error)[]): MessagesApi & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        const next = answers.shift();
        if (!next) throw new Error('fake client: no answer queued');
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

const apiError = (status: number, type: string, msg: string): InstanceType<typeof Anthropic.APIError> =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type, message: msg } }, msg, new Headers());

// --- selector ------------------------------------------------------------------------------------------------------

/** An env with an empty PATH, so the machine's own `claude` cannot leak into a selector case. */
const noPath = (env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: '', ...env });

/** A temp dir holding an executable `claude`, one holding a non-executable one, and one where `claude` is a directory
 * (which carries the execute bit, so only the file check rules it out). */
async function fakeBinDirs(): Promise<{ withClaude: string; withoutX: string; withDir: string; cleanup: () => Promise<void> }> {
  const [withClaude, withoutX, withDir] = await Promise.all(
    [0, 1, 2].map(() => mkdtemp(path.join(tmpdir(), 'awk-bin-'))),
  );
  await writeFile(path.join(withClaude, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(withoutX, 'claude'), 'not executable', { mode: 0o644 });
  await mkdir(path.join(withDir, 'claude'));
  const dirs = [withClaude, withoutX, withDir];
  return { withClaude, withoutX, withDir, cleanup: () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))).then(() => undefined) };
}

test('claudeOnPath finds an executable claude in a PATH entry, skips a non-executable one and a directory, and is false for an empty PATH', async () => {
  const dirs = await fakeBinDirs();
  try {
    assert.equal(claudeOnPath({ PATH: '' }), false);
    assert.equal(claudeOnPath({}), false);
    assert.equal(claudeOnPath({ PATH: dirs.withoutX }), false);
    assert.equal(claudeOnPath({ PATH: dirs.withDir }), false);
    assert.equal(claudeOnPath({ PATH: [dirs.withoutX, dirs.withDir, dirs.withClaude].join(path.delimiter) }), true);
  } finally {
    await dirs.cleanup();
  }
});

test('createLlm picks the mock with nothing set and logs why; an empty AWK_LLM or key counts as unset', async () => {
  for (const env of [noPath(), noPath({ ANTHROPIC_API_KEY: '', AWK_LLM: '' })]) {
    const { lines, log } = capture();
    const llm = createLlm(env, log);
    assert.match(lines[0], /info llm mode mode=mock reason="no AWK_LLM, no ANTHROPIC_API_KEY, no claude on PATH"$/);
    const res = await llm.complete({ prompt: 'hi' });
    assert.match(res.text, /^\[mock reply\]/);
  }
});

test('createLlm unset: a key picks anthropic over claude on PATH; claude on PATH alone picks claude-code', async () => {
  const dirs = await fakeBinDirs();
  try {
    let { lines, log } = capture();
    createLlm({ PATH: dirs.withClaude, ANTHROPIC_API_KEY: 'k' }, log);
    assert.match(lines[0], /info llm mode mode=anthropic reason="ANTHROPIC_API_KEY set" model=claude-sonnet-5$/);
    ({ lines, log } = capture());
    createLlm({ PATH: dirs.withClaude, ANTHROPIC_MODEL: 'claude-opus-5' }, log);
    assert.match(lines[0], /info llm mode mode=claude-code reason="claude on PATH" model=claude-opus-5$/);
  } finally {
    await dirs.cleanup();
  }
});

test('createLlm: AWK_LLM wins over the key and PATH; an unknown value throws LlmModeError naming it and the modes', async () => {
  assert.deepEqual(LLM_MODES, ['claude-code', 'anthropic', 'mock']);
  assert.equal(DEFAULT_MODEL, 'claude-sonnet-5');
  const dirs = await fakeBinDirs();
  const onPath = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ PATH: dirs.withClaude, ...env });
  try {
    const cases: [NodeJS.ProcessEnv, RegExp][] = [
      [noPath({ AWK_LLM: 'mock', ANTHROPIC_API_KEY: 'k' }), /mode=mock reason="AWK_LLM=mock"$/],
      [onPath({ AWK_LLM: 'claude-code', ANTHROPIC_API_KEY: 'k' }), /mode=claude-code reason="AWK_LLM=claude-code" model=claude-sonnet-5$/],
      [noPath({ AWK_LLM: 'anthropic' }), /mode=anthropic reason="AWK_LLM=anthropic" model=claude-sonnet-5$/],
      [noPath({ AWK_LLM: 'anthropic', ANTHROPIC_MODEL: '' }), /mode=anthropic reason="AWK_LLM=anthropic" model=claude-sonnet-5$/],
      [onPath({ AWK_LLM: 'claude-code', ANTHROPIC_MODEL: 'claude-opus-5' }), /mode=claude-code reason="AWK_LLM=claude-code" model=claude-opus-5$/],
    ];
    for (const [env, expected] of cases) {
      const { lines, log } = capture();
      createLlm(env, log);
      assert.equal(lines.length, 1);
      assert.match(lines[0], expected);
    }
  } finally {
    await dirs.cleanup();
  }
  const { lines, log } = capture();
  assert.throws(() => createLlm(noPath({ AWK_LLM: 'openai' }), log), (err: unknown) => {
    assert.ok(err instanceof LlmModeError);
    assert.equal(err.message, 'AWK_LLM="openai" is not a mode: expected one of claude-code, anthropic, mock');
    return true;
  });
  assert.equal(lines.length, 0);
});

test('createLlm throws LlmModeError for AWK_LLM=claude-code with no claude on PATH, before logging a mode line', async () => {
  const dirs = await fakeBinDirs();
  try {
    for (const env of [noPath({ AWK_LLM: 'claude-code' }), { PATH: dirs.withoutX, AWK_LLM: 'claude-code' }]) {
      const { lines, log } = capture();
      assert.throws(() => createLlm(env, log), (err: unknown) => {
        assert.ok(err instanceof LlmModeError);
        assert.equal(err.message, 'AWK_LLM=claude-code but no executable `claude` on PATH: install the Claude Code CLI or set AWK_LLM=anthropic|mock');
        return true;
      });
      assert.equal(lines.length, 0);
    }
    // The same env without AWK_LLM falls back to the mock rather than throwing.
    const { lines, log } = capture();
    createLlm(noPath(), log);
    assert.match(lines[0], /mode=mock /);
  } finally {
    await dirs.cleanup();
  }
});

// --- mock ----------------------------------------------------------------------------------------------------------

test('mockLlm returns mockReply verbatim, else a canned text quoting the prompt\'s first non-empty line', async () => {
  const { log } = capture();
  const llm = mockLlm({ log });
  const canned = await llm.complete({ system: 's', prompt: '\n  \n Write a haiku about rain.\nSecond line.' });
  assert.equal(canned.text, '[mock reply] offline mock, no model was called; the prompt began: Write a haiku about rain.');
  assert.equal(canned.truncated, false);
  const given = await llm.complete({ prompt: 'x', mockReply: '{"title":"T"}' });
  assert.equal(given.text, '{"title":"T"}');
  assert.equal((await llm.complete({ prompt: '' })).text.endsWith('began: '), true);
});

test('mockLlm usage is non-zero, proportional to the text, deterministic, and logged as model=mock', async () => {
  const { lines, log } = capture();
  const llm = mockLlm({ log });
  const short = await llm.complete({ prompt: 'a' });
  assert.deepEqual(short.usage, { input: 1, output: Math.ceil(short.text.length / 4) });
  const long = await llm.complete({ system: 'x'.repeat(40), prompt: 'y'.repeat(60), mockReply: 'z'.repeat(100) });
  assert.deepEqual(long.usage, { input: 25, output: 25 });
  assert.deepEqual(await llm.complete({ prompt: 'a' }), short);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /info llm model=mock ms=0 in=25 out=25 stop=end_turn$/);
  assert.equal(MOCK_MODEL, 'mock');
});

// --- anthropic -----------------------------------------------------------------------------------------------------

test('anthropicLlm sends model, max_tokens (default or given), system only when set, and the prompt as one user turn', async () => {
  const { log } = capture();
  const client = fakeClient([message(), message()]);
  const llm = anthropicLlm({ model: 'claude-sonnet-5', log, client });
  await llm.complete({ prompt: 'ping' });
  await llm.complete({ system: 'Be terse.', prompt: 'ping', maxTokens: 64, mockReply: 'ignored' });
  assert.deepEqual(client.calls[0], {
    model: 'claude-sonnet-5', max_tokens: DEFAULT_MAX_TOKENS, messages: [{ role: 'user', content: 'ping' }],
  });
  assert.deepEqual(client.calls[1], {
    model: 'claude-sonnet-5', max_tokens: 64, system: 'Be terse.', messages: [{ role: 'user', content: 'ping' }],
  });
});

test('anthropicLlm joins the text blocks (empty content included), sums input with cache tokens, flags both cut stop reasons as truncated, and logs the call', async () => {
  const { lines, log } = capture();
  const cached = message({
    content: [
      { type: 'thinking', thinking: '', signature: '' },
      { type: 'text', text: 'pong', citations: null },
      { type: 'text', text: '!', citations: null },
    ],
    usage: { ...message().usage, input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 9 },
  });
  const cut = message({ stop_reason: 'max_tokens', model: 'claude-opus-5' });
  const outOfWindow = message({ stop_reason: 'model_context_window_exceeded' });
  const empty = message({ content: [] });
  const llm = anthropicLlm({ model: 'm', log, client: fakeClient([cached, cut, outOfWindow, empty]) });
  const first = await llm.complete({ prompt: 'p' });
  assert.deepEqual(first, { text: 'pong!', usage: { input: 305, output: 9 }, truncated: false });
  const second = await llm.complete({ prompt: 'p' });
  assert.deepEqual(second, { text: 'pong', usage: { input: 11, output: 7 }, truncated: true });
  const third = await llm.complete({ prompt: 'p' });
  assert.deepEqual(third, { text: 'pong', usage: { input: 11, output: 7 }, truncated: true });
  const fourth = await llm.complete({ prompt: 'p' });
  assert.deepEqual(fourth, { text: '', usage: { input: 11, output: 7 }, truncated: false });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /info llm model=claude-sonnet-5 ms=\d+ in=305 out=9 stop=end_turn$/);
  assert.match(lines[1], /info llm model=claude-opus-5 ms=\d+ in=11 out=7 stop=max_tokens$/);
  assert.match(lines[2], /info llm model=claude-sonnet-5 ms=\d+ in=11 out=7 stop=model_context_window_exceeded$/);
});

test('anthropicLlm throws NonRetryableError for a refusal and for 4xx statuses a retry cannot fix, with the cause kept', async () => {
  const { lines, log } = capture();
  const details: Anthropic.RefusalStopDetails = { type: 'refusal', category: 'cyber', explanation: null };
  const refused = message({ content: [], stop_reason: 'refusal', stop_details: details });
  const uncategorized = message({ content: [], stop_reason: 'refusal', stop_details: null });
  const bad = apiError(400, 'invalid_request_error', 'max_tokens: must be positive');
  const llm = anthropicLlm({ model: 'm', log, client: fakeClient([refused, uncategorized, bad, apiError(401, 'authentication_error', 'invalid x-api-key')]) });
  await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof NonRetryableError);
    assert.equal(err.message, 'anthropic: the model refused this request (cyber)');
    assert.equal(err.cause, details);
    return true;
  });
  assert.match(lines[0], /info llm model=claude-sonnet-5 .* stop=refusal$/);
  await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof NonRetryableError);
    assert.equal(err.message, 'anthropic: the model refused this request (no category)');
    assert.equal(err.cause, undefined);
    return true;
  });
  await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof NonRetryableError);
    assert.equal(err.message, `anthropic: ${bad.message}`);
    assert.equal(err.cause, bad);
    return true;
  });
  await assert.rejects(llm.complete({ prompt: 'p' }), /^NonRetryableError: anthropic: 401/);
  assert.equal(lines.length, 2);
});

test('anthropicLlm rethrows rate limits, 5xx, connection errors and non-API errors as they are, so the runner retries', async () => {
  const { log } = capture();
  const errors = [
    apiError(429, 'rate_limit_error', 'slow down'),
    apiError(500, 'api_error', 'boom'),
    apiError(529, 'overloaded_error', 'overloaded'),
    new Anthropic.APIConnectionError({ message: 'socket hang up' }),
    new Anthropic.APIConnectionTimeoutError(),
    new Error('plain'),
  ];
  const llm = anthropicLlm({ model: 'm', log, client: fakeClient([...errors]) });
  for (const expected of errors) {
    await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
      assert.equal(err, expected);
      assert.equal(err instanceof NonRetryableError, false);
      return true;
    });
  }
  assert.ok(errors[0] instanceof Anthropic.RateLimitError);
  assert.ok(errors[1] instanceof Anthropic.InternalServerError);
});

test('anthropicLlm turns a non-API SDK error into NonRetryableError, but rethrows the SDK\'s own RetryableError', async () => {
  const { log } = capture();
  const clientSide = new Anthropic.AnthropicError('Streaming is required for operations that may take longer than 10 minutes.');
  const retryable = new RetryableError('again');
  const llm = anthropicLlm({ model: 'm', log, client: fakeClient([clientSide, retryable]) });
  await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof NonRetryableError);
    assert.equal(err.message, `anthropic: ${clientSide.message}`);
    assert.equal(err.cause, clientSide);
    return true;
  });
  await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
    assert.equal(err, retryable);
    assert.equal(err instanceof NonRetryableError, false);
    return true;
  });
});

// --- claude-code ---------------------------------------------------------------------------------------------------

/** A complete CLI result JSON (CC 2.1.269, the fields the client reads) with overrides. */
function resultJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', api_error_status: null, total_cost_usd: 0.0028,
    usage: { input_tokens: 880, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    result: 'Forty-two', num_turns: 1, session_id: 's', duration_ms: 1213,
    ...overrides,
  });
}

interface ExecCall { args: string[]; stdin: string; options: { env: NodeJS.ProcessEnv; timeoutMs: number } }
/** A fake exec that records each call and answers from a queue of results (or throws an Error). */
function fakeExec(answers: ({ code?: number; stdout?: string; stderr?: string } | Error)[]): ClaudeExec & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec = (async (args: string[], stdin: string, options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => {
    calls.push({ args, stdin, options });
    const next = answers.shift();
    if (!next) throw new Error('fake exec: no answer queued');
    if (next instanceof Error) throw next;
    return { code: next.code ?? 0, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
  }) as ClaudeExec & { calls: ExecCall[] };
  exec.calls = calls;
  return exec;
}

test('claudeCodeLlm runs claude -p headless with tools off, one turn, no session, no customizations, the model, --system-prompt on every call, the prompt on stdin and the given env and timeout', async () => {
  const { log } = capture();
  const exec = fakeExec([{ stdout: resultJson() }, { stdout: resultJson() }]);
  const env = { PATH: '/x', HOME: '/h' };
  const llm = claudeCodeLlm({ model: 'claude-opus-5', log, exec, env });
  await llm.complete({ prompt: 'ping' });
  await llm.complete({ system: 'Be terse.', prompt: 'line 1\nline 2 "quoted" $HOME', maxTokens: 64, mockReply: 'ignored' });
  const base = [
    '-p', '--output-format', 'json', '--model', 'claude-opus-5', '--tools', '', '--max-turns', '1',
    '--no-session-persistence', '--safe-mode', '--strict-mcp-config', '--system-prompt',
  ];
  const options = { env, timeoutMs: EXEC_TIMEOUT_MS };
  assert.equal(EXEC_TIMEOUT_MS, 10 * 60_000);
  assert.equal(DEFAULT_SYSTEM_PROMPT, 'You are a helpful assistant.');
  assert.deepEqual(exec.calls[0], { args: [...base, DEFAULT_SYSTEM_PROMPT], stdin: 'ping', options });
  assert.deepEqual(exec.calls[1], { args: [...base, 'Be terse.'], stdin: 'line 1\nline 2 "quoted" $HOME', options });
});

test('claudeCodeLlm passes an overridden timeoutMs through to the exec, and rejects an empty prompt before spawning', async () => {
  const { lines, log } = capture();
  const exec = fakeExec([{ stdout: resultJson() }]);
  const llm = claudeCodeLlm({ model: 'm', log, exec, env: {}, timeoutMs: 1234 });
  await assert.rejects(llm.complete({ prompt: '' }), (err: unknown) => {
    assert.ok(err instanceof NonRetryableError);
    assert.equal(err.message, 'claude-code: the prompt is empty');
    return true;
  });
  assert.equal(exec.calls.length, 0);
  assert.equal(lines.length, 0);
  await llm.complete({ prompt: 'p' });
  assert.deepEqual(exec.calls[0].options, { env: {}, timeoutMs: 1234 });
});

test('claudeCodeLlm returns the result text, sums cache tokens into input, flags both cut stop reasons as truncated, and logs the call with cost=', async () => {
  const { lines, log } = capture();
  const cached = resultJson({ usage: { input_tokens: 5, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 }, total_cost_usd: 0.5 });
  const cut = resultJson({ stop_reason: 'max_tokens' });
  const outOfWindow = resultJson({ stop_reason: 'model_context_window_exceeded' });
  const bare = resultJson({ result: undefined, usage: undefined, total_cost_usd: undefined, stop_reason: undefined });
  const llm = claudeCodeLlm({ model: 'm', log, exec: fakeExec([{ stdout: cached }, { stdout: cut }, { stdout: outOfWindow }, { stdout: bare }]) });
  assert.deepEqual(await llm.complete({ prompt: 'p' }), { text: 'Forty-two', usage: { input: 305, output: 9 }, truncated: false });
  assert.deepEqual(await llm.complete({ prompt: 'p' }), { text: 'Forty-two', usage: { input: 880, output: 7 }, truncated: true });
  assert.deepEqual(await llm.complete({ prompt: 'p' }), { text: 'Forty-two', usage: { input: 880, output: 7 }, truncated: true });
  assert.deepEqual(await llm.complete({ prompt: 'p' }), { text: '', usage: { input: 0, output: 0 }, truncated: false });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /info llm model=m ms=\d+ in=305 out=9 stop=end_turn cost=0\.5$/);
  assert.match(lines[1], /info llm model=m ms=\d+ in=880 out=7 stop=max_tokens cost=0\.0028$/);
  assert.match(lines[2], /info llm model=m ms=\d+ in=880 out=7 stop=model_context_window_exceeded cost=0\.0028$/);
  assert.match(lines[3], /info llm model=m ms=\d+ in=0 out=0 stop=unknown cost=0$/);
});

test('claudeCodeLlm throws a plain Error on a non-zero exit or is_error (the runner retries), after logging the call', async () => {
  const { lines, log } = capture();
  const limited = resultJson({ is_error: true, result: 'You have hit your limit; resets at 15:00', total_cost_usd: 0 });
  const llm = claudeCodeLlm({ model: 'm', log, exec: fakeExec([
    { code: 1, stdout: limited },
    { code: 0, stdout: resultJson({ is_error: true, api_error_status: 529, result: 'overloaded' }) },
    { code: 1, stdout: resultJson({ is_error: true, result: '' }), stderr: 'boom on stderr\n' },
  ]) });
  await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof Error && !(err instanceof NonRetryableError));
    assert.equal(err.message, 'claude-code: exit 1: You have hit your limit; resets at 15:00');
    assert.deepEqual(err.cause, JSON.parse(limited));
    return true;
  });
  await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof Error && !(err instanceof NonRetryableError));
    assert.equal(err.message, 'claude-code: exit 0, api status 529: overloaded');
    return true;
  });
  await assert.rejects(llm.complete({ prompt: 'p' }), /^Error: claude-code: exit 1: boom on stderr$/);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /info llm model=m .* stop=end_turn cost=0$/);
});

test('claudeCodeLlm throws NonRetryableError when the CLI reports an API status a retry cannot fix, with the result as the cause', async () => {
  const { log } = capture();
  const notFound = resultJson({ is_error: true, api_error_status: 404, result: "There's an issue with the selected model (nope)." });
  const llm = claudeCodeLlm({ model: 'nope', log, exec: fakeExec([{ code: 1, stdout: notFound }, { code: 1, stdout: resultJson({ is_error: true, api_error_status: 401, result: 'x' }) }, { code: 1, stdout: resultJson({ is_error: true, api_error_status: 429, result: 'slow' }) }]) });
  await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof NonRetryableError);
    assert.equal(err.message, "claude-code: exit 1, api status 404: There's an issue with the selected model (nope).");
    assert.deepEqual(err.cause, JSON.parse(notFound));
    return true;
  });
  await assert.rejects(llm.complete({ prompt: 'p' }), /^NonRetryableError: claude-code: exit 1, api status 401: x$/);
  await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
    assert.equal(err instanceof NonRetryableError, false);
    return true;
  });
});

test('claudeCodeLlm throws a plain Error when the output is not JSON (stderr, else stdout, in the message)', async () => {
  const { lines, log } = capture();
  const llm = claudeCodeLlm({ model: 'm', log, exec: fakeExec([{ code: 1, stdout: '', stderr: 'not logged in\n' }, { code: 0, stdout: 'plain text' }]) });
  await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof Error && !(err instanceof NonRetryableError));
    assert.equal(err.message, 'claude-code: exit 1, result is not JSON: not logged in');
    assert.ok(err.cause instanceof SyntaxError);
    return true;
  });
  await assert.rejects(llm.complete({ prompt: 'p' }), /^Error: claude-code: exit 0, result is not JSON: plain text$/);
  assert.equal(lines.length, 0);
});

test('claudeCodeLlm turns an ENOENT or EACCES spawn failure into NonRetryableError, and rethrows any other exec failure as it is', async () => {
  const { lines, log } = capture();
  const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  const denied = Object.assign(new Error('spawn claude EACCES'), { code: 'EACCES' });
  const killed = new Error('claude-code: claude killed by SIGTERM');
  const llm = claudeCodeLlm({ model: 'm', log, exec: fakeExec([missing, denied, killed]) });
  for (const spawnError of [missing, denied]) {
    await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
      assert.ok(err instanceof NonRetryableError);
      assert.equal(err.message, `claude-code: cannot run \`claude\`: ${spawnError.message}`);
      assert.equal(err.cause, spawnError);
      return true;
    });
  }
  await assert.rejects(llm.complete({ prompt: 'p' }), (err: unknown) => {
    assert.equal(err, killed);
    assert.equal(err instanceof NonRetryableError, false);
    return true;
  });
  assert.equal(lines.length, 0);
});

// --- defaultClaudeExec, against real temp scripts (never the machine's own `claude`) --------------------------------

/** A temp dir on which `claude` is the given shell script, and a PATH holding only that dir. POSIX only. */
async function scriptBin(body: string): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'awk-exec-'));
  await writeFile(path.join(dir, 'claude'), `#!/bin/sh\n${body}`, { mode: 0o755 });
  return { dir, env: { PATH: dir } };
}

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX only' : false };

test('defaultClaudeExec resolves when the child ignores a multi-MB stdin and exits 0 (the stdin error is swallowed)', posixOnly, async () => {
  const bin = await scriptBin(`printf '%s' '${resultJson()}'\nexit 0\n`);
  try {
    const res = await defaultClaudeExec(['-p'], 'x'.repeat(8 * 1024 * 1024), { env: bin.env, timeoutMs: EXEC_TIMEOUT_MS });
    assert.equal(res.code, 0);
    assert.equal(JSON.parse(res.stdout).result, 'Forty-two');
  } finally {
    await rm(bin.dir, { recursive: true, force: true });
  }
});

test('defaultClaudeExec rejects with the wrapped message when the child is killed by a signal', posixOnly, async () => {
  const bin = await scriptBin('kill -TERM $$\n');
  try {
    await assert.rejects(defaultClaudeExec(['-p'], 'p', { env: bin.env, timeoutMs: EXEC_TIMEOUT_MS }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'claude-code: claude killed by SIGTERM');
      assert.ok(err.cause instanceof Error);
      return true;
    });
  } finally {
    await rm(bin.dir, { recursive: true, force: true });
  }
});

test('defaultClaudeExec rejects with the spawn error, ENOENT code intact, when no claude is on the PATH it is given', posixOnly, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'awk-exec-'));
  try {
    await assert.rejects(defaultClaudeExec(['-p'], 'p', { env: { PATH: dir }, timeoutMs: EXEC_TIMEOUT_MS }), (err: unknown) => {
      assert.equal((err as { code?: unknown }).code, 'ENOENT');
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
