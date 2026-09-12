// Drives src/llm.ts: the selector, the offline mock, and the Anthropic implementation against a fake SDK client (no
// network). The CLI tests run the real SDK against a local stand-in server. Run with `npm test`.
import Anthropic, { RetryableError } from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicLlm, createLlm, DEFAULT_MAX_TOKENS, DEFAULT_MODEL, MOCK_MODEL, mockLlm, type MessagesApi } from '../src/llm.js';
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

test('createLlm picks the mock without ANTHROPIC_API_KEY and logs why; an empty key counts as unset', async () => {
  for (const env of [{}, { ANTHROPIC_API_KEY: '' }]) {
    const { lines, log } = capture();
    const llm = createLlm(env, log);
    assert.match(lines[0], /info llm mode mode=mock reason="ANTHROPIC_API_KEY not set"$/);
    const res = await llm.complete({ prompt: 'hi' });
    assert.match(res.text, /^\[mock reply\]/);
  }
});

test('createLlm picks the Anthropic client with a key: default model, or ANTHROPIC_MODEL when set and non-empty', () => {
  const cases: [NodeJS.ProcessEnv, string][] = [
    [{ ANTHROPIC_API_KEY: 'k' }, DEFAULT_MODEL],
    [{ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: '' }, DEFAULT_MODEL],
    [{ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-opus-5' }, 'claude-opus-5'],
  ];
  assert.equal(DEFAULT_MODEL, 'claude-sonnet-5');
  for (const [env, model] of cases) {
    const { lines, log } = capture();
    createLlm(env, log);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`info llm mode mode=anthropic model=${model}$`));
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
