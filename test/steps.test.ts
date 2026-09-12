// The step library (src/steps/): each step against a fake LLM, a loopback HTTP server or a temp directory — no
// network, no model. The example pipeline runs through the real runner offline (fixture + mock). Run with `npm test`.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import example from '../pipelines/example-changelog.js';
import { createLogger } from '../src/log.js';
import { mockLlm } from '../src/llm.js';
import { runPipeline } from '../src/runner.js';
import { draft, emailsIn, emitWith, example as exampleOf, extract, fetchPagesWith, hasHeading, htmlToText, matchesSchema, maxLength, minLength, noFabricatedEmails, noFabricatedUrls, parseJson, plan, requiredSections, urlsIn, validate, type Schema } from '../src/steps/index.js';
import { DEFAULT_INPUT_CHARS, renderInputs } from '../src/steps/shared.js';
import { NonRetryableError, type LlmClient, type LlmRequest, type StepContext } from '../src/types.js';

const tempDirs: string[] = [];
const servers: Server[] = [];
after(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'awk-steps-'));
  tempDirs.push(dir);
  return dir;
};

/** An LLM that answers from a queue (or with one canned text) and records every request. */
function fakeLlm(replies: string[] | string, truncated = false): LlmClient & { requests: LlmRequest[] } {
  const queue = Array.isArray(replies) ? [...replies] : [];
  const requests: LlmRequest[] = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const text = Array.isArray(replies) ? (queue.shift() ?? '') : replies;
      return { text, usage: { input: 10, output: 5 }, truncated };
    },
  };
}

function ctx<P>(params: P, inputs: Record<string, unknown> = {}, llm: LlmClient = fakeLlm(''), previousFailures: string[] = []): StepContext<P> & { lines: string[] } {
  const lines: string[] = [];
  return {
    runId: 'r', stepId: 'it', params, inputs, llm, flags: { dryRun: false, approve: false, fresh: false },
    log: createLogger((l) => lines.push(l)), attempt: previousFailures.length ? 2 : 1, previousFailures, lines,
  };
}

/** A loopback server whose handler decides per request; returns the base URL. */
async function serve(handler: (url: string, req: { method: string; headers: Record<string, unknown>; body: string }) => { status: number; body?: string; headers?: Record<string, string> }): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const out = handler(req.url ?? '/', { method: req.method ?? 'GET', headers: req.headers, body });
      res.writeHead(out.status, out.headers ?? { 'content-type': 'text/html' });
      res.end(out.body ?? '');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// --- shared / schema ---------------------------------------------------------------------------------------------

test('urlsIn finds unique URLs in order and strips trailing punctuation, emphasis and brackets', () => {
  assert.deepEqual(urlsIn('see https://a.io/x, then (https://b.io/y). Again https://a.io/x! and "https://c.io/z"'), ['https://a.io/x', 'https://b.io/y', 'https://c.io/z']);
  assert.deepEqual(urlsIn('bold **https://a.io/x** and _https://b.io/y_'), ['https://a.io/x', 'https://b.io/y']);
  assert.deepEqual(urlsIn('no links'), []);
});

test('urlsIn also finds scheme-less URLs, once each and not inside a full URL or an email address', () => {
  assert.deepEqual(urlsIn('per businessinsider.com and example.org/a/b.'), ['businessinsider.com', 'example.org/a/b']);
  assert.deepEqual(urlsIn('https://a.io/x then a.io/x'), ['https://a.io/x', 'a.io/x'], 'the host inside a full URL is not a second match');
  assert.deepEqual(urlsIn('write to sam@a.io about it'), [], 'an address after @ is an email, not a URL');
  assert.deepEqual(urlsIn('write to first.last@corp.com about it'), [], 'a dotted local part is part of the address, not a URL');
  assert.deepEqual(urlsIn('bold **b.io/y**'), ['b.io/y']);
  assert.deepEqual(urlsIn('run node.js'), ['node.js'], 'a dotted word that is not a domain matches too — the documented cost');
});

test('emailsIn finds unique addresses in order of first appearance', () => {
  assert.deepEqual(emailsIn('mail a.b+1@x.co, then B@Y.IO. Again a.b+1@x.co!'), ['a.b+1@x.co', 'B@Y.IO']);
  assert.deepEqual(emailsIn('italic _a@b.co_ and first.last@corp.com'), ['a@b.co', 'first.last@corp.com'], 'markdown emphasis is not part of the address');
  assert.deepEqual(emailsIn('no addresses here'), []);
});

test('renderInputs blocks each input by id, JSON-encodes the rest and clips at maxChars with a marker', () => {
  assert.equal(renderInputs([{ id: 'a', value: 'short' }, { id: 'b', value: { k: 1 } }]), '### input "a"\nshort\n\n### input "b"\n{\n  "k": 1\n}');
  assert.equal(renderInputs([{ id: 'a', value: 'abcdef' }], 3), '### input "a"\nabc\n[… cut at 3 characters]');
  const long = 'x'.repeat(DEFAULT_INPUT_CHARS + 1);
  assert.equal(renderInputs([{ id: 'a', value: long }]), `### input "a"\n${'x'.repeat(DEFAULT_INPUT_CHARS)}\n[… cut at ${DEFAULT_INPUT_CHARS} characters]`);
});

test('validate reports every violation by JSON path and passes a matching value with extra properties', () => {
  const schema: Schema = {
    type: 'object',
    properties: { name: { type: 'string', minLength: 2 }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1 }, n: { type: 'integer', minimum: 0 }, ok: { type: 'boolean' } },
    required: ['name', 'tags'],
  };
  assert.deepEqual(validate(schema, { name: 'ab', tags: ['a'], n: 1, ok: true, extra: 1 }), []);
  assert.deepEqual(validate(schema, { name: 'a', tags: ['c', 1], n: 1.5, ok: 'yes' }), [
    '$.name: expected at least 2 characters',
    '$.tags[0]: expected one of a, b, got "c"',
    '$.tags[1]: expected a string, got number',
    '$.n: expected an integer',
    '$.ok: expected a boolean, got string',
  ]);
  assert.deepEqual(validate(schema, {}), ['$.name: required property is missing', '$.tags: required property is missing']);
  assert.deepEqual(validate(schema, []), ['$: expected an object, got array']);
  assert.deepEqual(validate({ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, [1]), ['$: expected at least 2 items, got 1']);
  assert.deepEqual(validate({ type: 'string', pattern: '^v\\d' }, 'x1'), ['$: expected to match /^v\\d/']);
});

test('example builds a value that validates: every property, minItems items, the first enum member, minLength padding, minimum', () => {
  const schema: Schema = {
    type: 'object',
    properties: { name: { type: 'string', minLength: 20 }, kind: { type: 'string', enum: ['x', 'y'] }, items: { type: 'array', items: { type: 'integer', minimum: 3 }, minItems: 2 }, flag: { type: 'boolean' } },
    required: ['name'],
  };
  const value = exampleOf(schema) as Record<string, unknown>;
  assert.deepEqual(validate(schema, value), []);
  assert.deepEqual(value, { name: 'example name'.padEnd(20, 'x'), kind: 'x', items: [3, 3], flag: true });
});

test('example honours the constraints validate checks: maxItems, an enum member long enough, a rounded-up integer minimum', () => {
  const cases: Schema[] = [
    { type: 'array', items: { type: 'string' }, maxItems: 0 },
    { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5 },
    { type: 'string', enum: ['ab', 'abcde'], minLength: 5 },
    { type: 'string', enum: ['v1', 'draft'], pattern: '^v\\d+' },
    { type: 'integer', minimum: 0.5 },
    { type: 'integer', maximum: -0.5 },
    { type: 'number', minimum: 0.5, maximum: 2 },
  ];
  for (const schema of cases) assert.deepEqual(validate(schema, exampleOf(schema)), [], JSON.stringify(schema));
  assert.deepEqual(exampleOf(cases[0]), []);
  assert.equal((exampleOf(cases[1]) as unknown[]).length, 3);
  assert.equal(exampleOf(cases[2]), 'abcde');
  assert.equal(exampleOf(cases[3]), 'v1');
  assert.equal(exampleOf(cases[4]), 1);
  assert.equal(exampleOf(cases[5]), -1);
  assert.equal(exampleOf(cases[6]), 0.5);
});

test('example refuses a schema it cannot satisfy: a bare pattern, an unusable enum, an empty range', () => {
  const refused: [Schema, RegExp][] = [
    [{ type: 'string', pattern: '^v\\d+' }, /pattern \(\/\^v\\d\+\/\) is not synthesized/],
    [{ type: 'string', enum: ['ab'], minLength: 5 }, /no enum member satisfies/],
    [{ type: 'integer', minimum: 0.5, maximum: 0.7 }, /no integer lies between/],
    [{ type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 1 }, /minItems 2 is above maxItems 1/],
  ];
  for (const [schema, message] of refused) {
    assert.throws(() => exampleOf(schema, 'tag'), (err: unknown) => err instanceof NonRetryableError && /"tag" has no generated example/.test(err.message) && message.test(err.message));
  }
});

test('a pattern that does not compile is non-retryable in validate and in example, not a thrown SyntaxError', () => {
  const schema: Schema = { type: 'string', pattern: '^(' };
  assert.throws(() => validate(schema, 'x'), (err: unknown) => err instanceof NonRetryableError && /pattern \/\^\(\/ does not compile/.test(err.message));
  assert.throws(() => exampleOf(schema), NonRetryableError);
});

// --- fetchPages ----------------------------------------------------------------------------------------------------

test('htmlToText drops scripts, styles and tags, breaks on block tags, decodes entities and collapses whitespace', () => {
  const html = '<html><head><title>T &amp; U</title><style>p{}</style><script>x<y</script></head><body><h1>Hi</h1>\n\n\n<p>one &lt;two&gt;&nbsp;&#65;&#x42;</p><ul><li>a</li><li>b</li></ul><!-- c --><a href="https://x.io/z">link</a> <span>tail</span></body></html>';
  assert.equal(htmlToText(html), 'Hi\n\none <two> AB\n\na\n\nb\n\nlink (https://x.io/z) tail');
});

test('htmlToText keeps an absolute link target after its text, skips the other href kinds and never doubles a URL', () => {
  assert.equal(htmlToText('<p><a href="https://x.io/z">read <b>this</b></a></p>'), 'read this (https://x.io/z)');
  assert.equal(htmlToText('<p><a href=\'https://x.io/a?p=1&amp;q=2\'>q</a></p>'), 'q (https://x.io/a?p=1&q=2)');
  assert.equal(htmlToText('<p><a href=https://x.io/u>u</a></p>'), 'u (https://x.io/u)');
  assert.equal(htmlToText('<p><a href="https://x.io/z">https://x.io/z</a></p>'), 'https://x.io/z', 'the anchor text already is the URL');
  assert.equal(htmlToText('<p><a href="https://x.io/z">x.io/z/</a></p>'), 'x.io/z/', 'the same URL, scheme and trailing slash aside');
  assert.equal(htmlToText('<P><A HREF="https://x.io/Z">up</A></P>'), 'up (https://x.io/Z)');
  assert.equal(htmlToText('<p><a class="c" href="https://x.io/z" rel="nofollow">both sides</a></p>'), 'both sides (https://x.io/z)');
  assert.equal(htmlToText('<p><a data-href="https://tracker.evil/x" href="https://real.io/y">t</a></p>'), 't (https://real.io/y)', 'a data-href decoy is not the target');
  const skipped = '<p><a href="/rel">a</a> <a href="#top">b</a> <a href="javascript:x()">c</a> <a href="mailto:s@x.io">d</a> <a href="tel:+1">e</a> <a>f</a></p>';
  assert.equal(htmlToText(skipped), 'a b c d e f');
});

test('fetchPages GETs each URL with the user agent and headers, reduces HTML to text with the title, keeps other bodies as they are, and caps the text', async () => {
  const seen: Record<string, unknown>[] = [];
  const base = await serve((url, req) => {
    seen.push(req.headers);
    if (url === '/page') return { status: 200, body: '<html><head><title>A page</title></head><body><p>Hello</p><p>World</p></body></html>' };
    return { status: 200, body: '{"a":1}', headers: { 'content-type': 'application/json' } };
  });
  const c = ctx({ urls: [`${base}/page`, `${base}/data.json`], headers: { accept: 'text/plain' }, maxChars: 8 });
  const { output } = await fetchPagesWith({ env: {} }).run(c);
  assert.deepEqual(output, [
    { url: `${base}/page`, title: 'A page', text: 'Hello\n\nWorld'.slice(0, 8) + '\n[… cut at 8 characters]', source: 'http' },
    { url: `${base}/data.json`, title: `${base}/data.json`, text: '{"a":1}', source: 'http' },
  ]);
  assert.match(String(seen[0]['user-agent']), /^agentic-workflow-kit\//);
  assert.equal(seen[0].accept, 'text/plain');
  assert.ok(c.lines.some((l) => l.includes('info fetched') && l.includes('source=http') && l.includes('status=200')));
});

test('fetchPages throws a plain Error on a retryable status (retried with a wait) and NonRetryableError on any other', async () => {
  const base = await serve((url) => ({ status: Number(url.slice(1)) }));
  await assert.rejects(fetchPagesWith({ env: {} }).run(ctx({ urls: [`${base}/503`] })), (err: unknown) => err instanceof Error && !(err instanceof NonRetryableError) && /answered 503/.test(err.message));
  await assert.rejects(fetchPagesWith({ env: {} }).run(ctx({ urls: [`${base}/429`] })), (err: unknown) => err instanceof Error && !(err instanceof NonRetryableError));
  await assert.rejects(fetchPagesWith({ env: {} }).run(ctx({ urls: [`${base}/408`] })), (err: unknown) => err instanceof Error && !(err instanceof NonRetryableError), 'the shared predicate counts 408 too');
  await assert.rejects(fetchPagesWith({ env: {} }).run(ctx({ urls: [`${base}/404`] })), (err: unknown) => err instanceof NonRetryableError && /answered 404 Not Found/.test(err.message));
  await assert.rejects(fetchPagesWith({ env: {} }).run(ctx({ urls: [] })), /no urls/);
});

test('fetchPages falls back to the fixture for a failure a retry cannot fix, uses it without a request under AWK_OFFLINE=1, and fails legibly when it is missing', async () => {
  const dir = await tempDir();
  const fixture = path.join(dir, 'page.html');
  await writeFile(fixture, '<title>Fixture</title><p>from disk</p>');
  let requests = 0;
  const base = await serve(() => (requests++, { status: 404 }));
  const url = `${base}/x`;
  const c = ctx({ urls: [url], fixtures: { [url]: fixture } });
  const fallback = await fetchPagesWith({ env: {} }).run(c);
  assert.deepEqual(fallback.output, [{ url, title: 'Fixture', text: 'from disk', source: 'fixture' }]);
  assert.equal(requests, 1);
  assert.ok(c.lines.some((l) => l.includes('warn fetched') && l.includes('source=fixture') && l.includes('answered 404')));
  const unreachable = ctx({ urls: ['http://127.0.0.1:1/x'], fixtures: { 'http://127.0.0.1:1/x': fixture } });
  assert.equal((await fetchPagesWith({ env: {} }).run(unreachable)).output[0].source, 'fixture', 'a connection failure falls back too');
  const offline = await fetchPagesWith({ env: { AWK_OFFLINE: '1' } }).run(ctx({ urls: [url], fixtures: { [url]: fixture } }));
  assert.equal(offline.output[0].source, 'fixture');
  assert.equal(requests, 1, 'offline made no request');
  await assert.rejects(fetchPagesWith({ env: { AWK_OFFLINE: '1' } }).run(ctx({ urls: [url] })), (err: unknown) => err instanceof NonRetryableError && /AWK_OFFLINE=1 and no fixture/.test(err.message));
  await assert.rejects(fetchPagesWith({ env: { AWK_OFFLINE: '1' } }).run(ctx({ urls: [url], fixtures: { [url]: path.join(dir, 'nope') } })), (err: unknown) => err instanceof NonRetryableError && /fixture for .* cannot be read/.test(err.message));
});

test('fetchPages throws a retryable status past the fixture, so the runner retries instead of reporting a stale snapshot', async () => {
  const dir = await tempDir();
  const fixture = path.join(dir, 'page.html');
  await writeFile(fixture, '<title>Fixture</title><p>from disk</p>');
  const base = await serve(() => ({ status: 503 }));
  const url = `${base}/x`;
  const c = ctx({ urls: [url], fixtures: { [url]: fixture } });
  await assert.rejects(fetchPagesWith({ env: {} }).run(c), (err: unknown) => err instanceof Error && !(err instanceof NonRetryableError) && /answered 503/.test(err.message));
  assert.ok(!c.lines.some((l) => l.includes('source=fixture')), 'the fixture was not used');
});

test('fetchPages verify fails an empty page', () => {
  assert.deepEqual(fetchPagesWith().verify!([{ url: 'u', title: 'u', text: '  ', source: 'http' }], ctx({ urls: ['u'] })), ['u: empty page text']);
});

// --- extract -------------------------------------------------------------------------------------------------------

test('parseJson takes the whole text, a ```json fence, or the outermost object span, and reports the last error otherwise', () => {
  assert.deepEqual(parseJson(' {"a":1} '), { a: 1 });
  assert.deepEqual(parseJson('Here:\n```json\n[1,2]\n```\nDone'), [1, 2]);
  assert.deepEqual(parseJson('Sure! {"a":{"b":2}} — that is all.'), { a: { b: 2 } });
  const bad = parseJson('no json here');
  assert.ok(bad instanceof Error);
  assert.ok((parseJson('') as Error).message.includes('empty answer'));
});

test('extract renders the inputs and the schema into the prompt, parses the answer and validates it; a retry carries the failures', async () => {
  const schema: Schema = { type: 'object', properties: { tag: { type: 'string' }, n: { type: 'integer' } }, required: ['tag', 'n'] };
  const llm = fakeLlm(['```json\n{"tag":"v1","n":"x"}\n```']);
  const c = ctx({ from: 'src', instruction: 'Get the tag.', schema }, { src: 'The tag is v1 (#3).' }, llm);
  const { output, usage } = await extract.run(c);
  assert.deepEqual(output, { tag: 'v1', n: 'x' });
  assert.deepEqual(usage, { input: 10, output: 5 });
  assert.deepEqual(extract.verify!(output, c), ['$.n: expected an integer, got string']);
  const req = llm.requests[0];
  assert.match(req.system ?? '', /one JSON value only/);
  assert.match(req.prompt, /^Get the tag\.\n\nThe JSON must match this schema:\n\{/);
  assert.match(req.prompt, /### input "src"\nThe tag is v1 \(#3\)\./);
  assert.deepEqual(JSON.parse(req.mockReply ?? ''), { tag: 'example tag', n: 0 });
  const retry = ctx({ from: 'src', instruction: 'Get the tag.', schema }, { src: 'x' }, llm, ['$.n: expected an integer, got string']);
  await extract.run(retry);
  assert.match(llm.requests[1].prompt, /rejected for these reasons[^\n]*\n1\. \$\.n: expected an integer, got string$/);
});

test('extract turns a non-JSON answer into a verify failure (not a throw), and names a missing input as non-retryable', async () => {
  const schema: Schema = { type: 'object', properties: {} };
  const c = ctx({ from: 'src', instruction: 'x', schema }, { src: 'y' }, fakeLlm('not json at all'));
  const { output } = await extract.run(c);
  assert.deepEqual(extract.verify!(output, c), ['the answer is not JSON: Unexpected token \'o\', "not json at all" is not valid JSON']);
  await assert.rejects(extract.run(ctx({ from: 'missing', instruction: 'x', schema }, { src: 'y' })), (err: unknown) => err instanceof NonRetryableError && /input "missing" is not the output of an earlier step/.test(err.message));
});

test('extract stops the run when the answer was cut short at maxTokens, and caps each input at maxInputChars', async () => {
  const schema = { type: 'object', properties: {} } as Schema;
  await assert.rejects(
    extract.run(ctx({ from: 'src', instruction: 'x', schema, maxTokens: 64 }, { src: 'y' }, fakeLlm('{}', true))),
    (err: unknown) => err instanceof NonRetryableError && /step "it": the answer was cut short at maxTokens=64/.test(err.message),
  );
  const llm = fakeLlm('{}');
  await extract.run(ctx({ from: 'src', instruction: 'x', schema, maxInputChars: 4 }, { src: 'abcdefgh' }, llm));
  assert.match(llm.requests[0].prompt, /### input "src"\nabcd\n\[… cut at 4 characters\]/);
});

// --- plan / draft --------------------------------------------------------------------------------------------------

test('hasHeading matches any level, case-insensitively, with closing hashes, and nothing else', () => {
  assert.ok(hasHeading('# Summary', 'summary'));
  assert.ok(hasHeading('text\n### Links ###\n', 'Links'));
  assert.ok(!hasHeading('Summary\n#Summary\n- Summary', 'Summary'));
  assert.ok(!hasHeading('## Summary of links', 'Summary'));
});

test('plan asks for the sections in order, verifies them, and the mock reply carries them', async () => {
  const llm = fakeLlm('## A\n- p\n\n## B\n- q');
  const c = ctx({ from: ['x', 'y'], goal: 'G', sections: ['A', 'B'] }, { x: 'sx', y: { k: 1 } }, llm);
  const { output } = await plan.run(c);
  assert.equal(output, '## A\n- p\n\n## B\n- q');
  assert.deepEqual(plan.verify!(output, c), []);
  assert.deepEqual(plan.verify!('## A\n- p', c), ['missing section "## B"']);
  assert.deepEqual(plan.verify!('', c), ['empty plan', 'missing section "## A"', 'missing section "## B"']);
  const req = llm.requests[0];
  assert.match(req.prompt, /^Goal: G\n\nUse exactly these sections, in this order: "A", "B"\.\n\nSources:\n\n### input "x"\nsx\n\n### input "y"\n\{\n  "k": 1\n\}$/);
  assert.equal(req.mockReply, '## A\n- [mock] point for A, from input "x"\n\n## B\n- [mock] point for B, from input "x"');
  assert.deepEqual(plan.verify!('anything', ctx({ from: 'x', goal: 'G' }, { x: 's' })), []);
});

test('draft renders the instruction, sections and inputs, verifies the sections, and its mock reply cites only source URLs', async () => {
  const llm = fakeLlm('## S\n\nbody');
  const c = ctx({ from: 'facts', instruction: 'Write it.', sections: ['S'] }, { facts: { url: 'https://a.io/1', more: 'https://a.io/2 https://a.io/3 https://a.io/4' } }, llm);
  const { output } = await draft.run(c);
  assert.equal(output, '## S\n\nbody');
  assert.deepEqual(draft.verify!(output, c), []);
  assert.deepEqual(draft.verify!('no heading', c), ['missing section "## S"']);
  const req = llm.requests[0];
  assert.match(req.prompt, /^Write it\.\n\nUse exactly these "## " sections, in this order: "S"\.\n\nSources:\n\n### input "facts"\n\{/);
  const mock = req.mockReply ?? '';
  assert.ok(hasHeading(mock, 'S'));
  assert.ok(mock.length >= 600, `mock draft is ${mock.length} chars`);
  assert.deepEqual(urlsIn(mock), ['https://a.io/1', 'https://a.io/2', 'https://a.io/3'], 'at most three source URLs');
  assert.deepEqual(noFabricatedUrls('facts')(mock, c), []);
});

test('draft and plan stop the run when the answer was cut short at maxTokens: a half-written piece is not the deliverable', async () => {
  const cut = fakeLlm('## S\n\nbody', true);
  const isCutShort = (err: unknown): boolean => err instanceof NonRetryableError && /step "it": the answer was cut short at maxTokens=the client default/.test((err as Error).message);
  await assert.rejects(draft.run(ctx({ from: 'src', instruction: 'Write it.', sections: ['S'] }, { src: 'y' }, cut)), isCutShort);
  await assert.rejects(plan.run(ctx({ from: 'src', goal: 'G', sections: ['S'] }, { src: 'y' }, cut)), isCutShort);
});

// --- verify rules --------------------------------------------------------------------------------------------------

test('minLength / maxLength / requiredSections / matchesSchema report in words and pass otherwise', async () => {
  const c = ctx({});
  assert.deepEqual(await minLength(5)('abcdef', c), []);
  assert.deepEqual(await minLength(5)('abc', c), ['too short: 3 characters, at least 5 required']);
  assert.deepEqual(await minLength(5)({ a: 1 }, c), [], 'a non-string is measured as JSON');
  assert.deepEqual(await maxLength(2)('abc', c), ['too long: 3 characters, at most 2 allowed']);
  assert.deepEqual(await requiredSections(['A', 'B'])('# a\n## c', c), ['missing section "B"']);
  assert.deepEqual(await matchesSchema({ type: 'array', items: { type: 'string' } })(['x', 1], c), ['$[1]: expected a string, got number']);
});

test('noFabricatedUrls accepts URLs found in the named inputs or the allow list (scheme and trailing slash ignored) and names every other one', async () => {
  const c = ctx({}, { pages: [{ url: 'https://a.io/p/', text: 'see https://b.io/q.' }], facts: { link: 'https://c.io/r' } });
  const rule = noFabricatedUrls(['pages', 'facts'], ['https://ok.io']);
  assert.deepEqual(await rule('Links: https://a.io/p, https://b.io/q, https://c.io/r/, https://ok.io/', c), []);
  assert.deepEqual(await rule('Links: a.io/p and http://b.io/q/', c), [], 'a scheme-less or http citation of an https source is the same URL');
  assert.deepEqual(await rule('Links: https://A.IO/p', c), [], 'the host is compared case-insensitively');
  assert.deepEqual(await rule('See https://a.io/other and https://made.up/x.', c), ['URL not in the sources: https://a.io/other', 'URL not in the sources: https://made.up/x']);
  assert.deepEqual(await rule('Per businessinsider.com.', c), ['URL not in the sources: businessinsider.com'], 'a bare domain does not get past the rule');
  assert.deepEqual(await noFabricatedUrls('pages')('no links', c), []);
  assert.throws(
    () => noFabricatedUrls(['pagez'])('see https://a.io/x', c),
    (err: unknown) => err instanceof NonRetryableError && /input "pagez" is not the output of an earlier step/.test(err.message),
    'a step id that is not an input would flag every URL, so it fails the run instead',
  );
});

test('noFabricatedEmails accepts addresses found in the named inputs or the allow list (case ignored) and names every other one', async () => {
  const c = ctx({}, { pages: [{ url: 'https://a.io/p', text: 'write to Sam@a.io.' }], facts: { contact: 'ops@b.io' } });
  const rule = noFabricatedEmails(['pages', 'facts'], ['desk@ok.io']);
  assert.deepEqual(await rule('Contact sam@A.IO, ops@b.io or DESK@ok.io.', c), []);
  assert.deepEqual(await rule('Booking: me@laptop.local and other@c.io.', c), ['email not in the sources: me@laptop.local', 'email not in the sources: other@c.io']);
  assert.deepEqual(await noFabricatedEmails('pages')('no addresses', c), []);
  assert.throws(
    () => noFabricatedEmails(['pagez'])('mail x@y.io', c),
    (err: unknown) => err instanceof NonRetryableError && /input "pagez" is not the output of an earlier step/.test(err.message),
    'a step id that is not an input would flag every address, so it fails the run instead',
  );
});

// --- emit ----------------------------------------------------------------------------------------------------------

test('emit writes the input under dir/ (a title prepended when there is no top heading), reports the artifact, and skips the PR without a token', async () => {
  const dir = await tempDir();
  const c = ctx({ from: 'post', path: 'sub/post.md', title: 'T', dir, pr: { repo: 'o/r', branch: 'b' } }, { post: '## S\n\nbody\n\n' });
  const { output, artifact } = await emitWith({ env: {} }).run(c);
  const file = path.join(dir, 'sub', 'post.md');
  assert.equal(artifact, file);
  assert.deepEqual(output, { path: file, bytes: 16 });
  assert.equal(await readFile(file, 'utf8'), '# T\n\n## S\n\nbody\n');
  assert.ok(c.lines.some((l) => l.includes('warn pr skipped') && l.includes('GITHUB_TOKEN is not set')));
  const json = await emitWith({ env: {} }).run(ctx({ from: 'data', path: 'd.md', dir }, { data: { a: 1 } }));
  assert.equal(await readFile(json.output.path, 'utf8'), '{\n  "a": 1\n}\n');
  const titled = await emitWith({ env: {} }).run(ctx({ from: 'p', path: 'h.md', title: 'T', dir }, { p: '# Own\n\nx' }));
  assert.equal(await readFile(titled.output.path, 'utf8'), '# Own\n\nx\n');
});

test('emit refuses a path outside dir/, a path naming a directory and a missing input, all non-retryable, but keeps a file named "..cache.md"', async () => {
  const dir = await tempDir();
  await assert.rejects(emitWith({ env: {} }).run(ctx({ from: 'p', path: '../x.md', dir }, { p: 'x' })), (err: unknown) => err instanceof NonRetryableError && /must stay under/.test(err.message));
  await assert.rejects(emitWith({ env: {} }).run(ctx({ from: 'p', path: '/abs.md', dir }, { p: 'x' })), NonRetryableError);
  await assert.rejects(emitWith({ env: {} }).run(ctx({ from: 'p', path: '', dir }, { p: 'x' })), (err: unknown) => err instanceof NonRetryableError && /must name a file/.test(err.message));
  await assert.rejects(emitWith({ env: {} }).run(ctx({ from: 'p', path: 'sub/', dir }, { p: 'x' })), (err: unknown) => err instanceof NonRetryableError && /must name a file/.test(err.message));
  await assert.rejects(emitWith({ env: {} }).run(ctx({ from: 'nope', path: 'x.md', dir }, { p: 'x' })), (err: unknown) => err instanceof NonRetryableError && /input "nope"/.test(err.message));
  const dotted = await emitWith({ env: {} }).run(ctx({ from: 'p', path: '..cache.md', dir }, { p: 'x' }));
  assert.equal(dotted.output.path, path.join(dir, '..cache.md'));
});

test('emit with GITHUB_TOKEN branches from the default branch, puts the file and opens the PR; a re-run reuses the branch, updates the file and finds the open PR', async () => {
  const dir = await tempDir();
  const calls: string[] = [];
  // Recorded here, asserted after run: an assertion inside the handler would escape the test as a server exception.
  const seen: { call: string; auth: unknown; body: string }[] = [];
  let branchExists = false;
  let fileSha: string | undefined;
  let prOpen = false;
  const base = await serve((url, req) => {
    calls.push(`${req.method} ${url}`);
    seen.push({ call: `${req.method} ${url}`, auth: req.headers.authorization, body: req.body });
    const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    if (url === '/repos/o/r' && req.method === 'GET') return json(200, { default_branch: 'main' });
    if (url === '/repos/o/r/git/ref/heads/main') return json(200, { object: { sha: 'abc' } });
    if (url === '/repos/o/r/git/refs' && req.method === 'POST') {
      if (branchExists) return json(422, { message: 'Reference already exists' });
      branchExists = true;
      return json(201, {});
    }
    if (url === '/repos/o/r/contents/docs/post.md?ref=kit%2Fpost') return fileSha ? json(200, { sha: fileSha }) : json(404, { message: 'Not Found' });
    if (url === '/repos/o/r/contents/docs/post.md' && req.method === 'PUT') {
      const created = fileSha === undefined;
      fileSha = 'f1';
      return json(created ? 201 : 200, {});
    }
    if (url.startsWith('/repos/o/r/pulls?head=o%3Akit%2Fpost&base=main&state=open')) return json(200, prOpen ? [{ html_url: 'https://gh/pr/7', number: 7 }] : []);
    if (url === '/repos/o/r/pulls' && req.method === 'POST') {
      prOpen = true;
      return json(201, { html_url: 'https://gh/pr/7', number: 7 });
    }
    return json(500, { message: `unexpected ${req.method} ${url}` });
  });
  const env = { GITHUB_TOKEN: 'tok', GITHUB_API_URL: base };
  const params = { from: 'p', path: 'docs/post.md', dir, pr: { repo: 'o/r', branch: 'kit/post' } };
  const first = await emitWith({ env }).run(ctx(params, { p: 'hello' }));
  assert.deepEqual(first.output.pr, { url: 'https://gh/pr/7', number: 7, branch: 'kit/post', created: true });
  const bodyOf = (call: string): any => JSON.parse(seen.find((s) => s.call === call)!.body);
  assert.deepEqual(seen.map((s) => s.auth), seen.map(() => 'Bearer tok'), 'every call carries the token');
  assert.deepEqual(bodyOf('POST /repos/o/r/git/refs'), { ref: 'refs/heads/kit/post', sha: 'abc' });
  const put = bodyOf('PUT /repos/o/r/contents/docs/post.md');
  assert.equal(Buffer.from(put.content, 'base64').toString(), 'hello\n');
  assert.equal(put.branch, 'kit/post');
  assert.equal(put.message, 'docs: docs/post.md');
  assert.equal(put.sha, undefined, 'the file did not exist yet');
  assert.deepEqual(bodyOf('POST /repos/o/r/pulls'), { title: 'Add docs/post.md', body: '', head: 'kit/post', base: 'main' });
  assert.deepEqual(calls, [
    'GET /repos/o/r', 'GET /repos/o/r/git/ref/heads/main', 'POST /repos/o/r/git/refs', 'GET /repos/o/r/contents/docs/post.md?ref=kit%2Fpost',
    'PUT /repos/o/r/contents/docs/post.md', 'GET /repos/o/r/pulls?head=o%3Akit%2Fpost&base=main&state=open', 'POST /repos/o/r/pulls',
  ]);
  calls.length = 0;
  seen.length = 0;
  const second = await emitWith({ env }).run(ctx(params, { p: 'hello' }));
  assert.deepEqual(second.output.pr, { url: 'https://gh/pr/7', number: 7, branch: 'kit/post', created: false });
  assert.ok(!calls.includes('POST /repos/o/r/pulls'), 'no second PR');
  assert.equal(bodyOf('PUT /repos/o/r/contents/docs/post.md').sha, 'f1', 'the re-run updates the file it found');
});

test('emit maps GitHub statuses: 5xx / 429 and a rate-limited 403 retryable, other failures non-retryable with the message', async () => {
  const dir = await tempDir();
  let status = 503;
  let extra: Record<string, string> = {};
  const base = await serve(() => ({ status, body: JSON.stringify({ message: 'nope' }), headers: { 'content-type': 'application/json', ...extra } }));
  const env = { GITHUB_TOKEN: 'tok', GITHUB_API_URL: base };
  const params = { from: 'p', path: 'x.md', dir, pr: { repo: 'o/r', branch: 'b', base: 'main' } };
  const retryable = (err: unknown): boolean => err instanceof Error && !(err instanceof NonRetryableError);
  await assert.rejects(emitWith({ env }).run(ctx(params, { p: 'x' })), (err: unknown) => retryable(err) && /GET \/repos\/o\/r\/git\/ref\/heads\/main answered 503: nope/.test((err as Error).message));
  status = 401;
  await assert.rejects(emitWith({ env }).run(ctx(params, { p: 'x' })), (err: unknown) => err instanceof NonRetryableError && /answered 401: nope/.test(err.message));
  // GitHub answers 403 for a secondary rate limit: retryable only with the rate-limit signal, fatal without it.
  status = 403;
  await assert.rejects(emitWith({ env }).run(ctx(params, { p: 'x' })), (err: unknown) => err instanceof NonRetryableError && /answered 403: nope/.test(err.message));
  extra = { 'x-ratelimit-remaining': '0' };
  await assert.rejects(emitWith({ env }).run(ctx(params, { p: 'x' })), retryable);
  extra = { 'retry-after': '60' };
  await assert.rejects(emitWith({ env }).run(ctx(params, { p: 'x' })), retryable);
});

test('emit resolves a base branch whose name contains a slash', async () => {
  const dir = await tempDir();
  const calls: string[] = [];
  const base = await serve((url) => {
    calls.push(url);
    return { status: 404, body: JSON.stringify({ message: 'Not Found' }), headers: { 'content-type': 'application/json' } };
  });
  const env = { GITHUB_TOKEN: 'tok', GITHUB_API_URL: base };
  const params = { from: 'p', path: 'x.md', dir, pr: { repo: 'o/r', branch: 'b', base: 'release/1.x' } };
  await assert.rejects(emitWith({ env }).run(ctx(params, { p: 'x' })), NonRetryableError);
  assert.deepEqual(calls, ['/repos/o/r/git/ref/heads/release/1.x']);
});

// --- the example pipeline ------------------------------------------------------------------------------------------

test('the example pipeline runs green offline through the runner (fixture + mock) and writes out/changelog.md', async () => {
  const cwd = await tempDir();
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l));
  // The fixture path in the pipeline is cwd-relative and emit writes under out/, so run from the package root with the
  // output redirected: the publish step is re-targeted at the temp dir.
  const publish = example.steps.find((s) => s.id === 'publish')!;
  const pipeline = { ...example, steps: example.steps.map((s) => (s === publish ? { ...s, params: { ...s.params, dir: cwd } } : s)) };
  const saved = process.env.AWK_OFFLINE;
  process.env.AWK_OFFLINE = '1';
  try {
    // A no-op sleep, as everywhere in the suite: a step left on DEFAULT_RETRY cannot stall it with real backoff.
    const result = await runPipeline(pipeline, { flags: { dryRun: false, approve: true, fresh: true }, llm: mockLlm({ log }), log, runsDir: path.join(cwd, 'runs'), sleep: async () => {} });
    assert.equal(result.ok, true, lines.join('\n'));
    assert.deepEqual(result.records.map((r) => `${r.id}:${r.status}:${r.attempts}`), ['releases:done:1', 'facts:done:1', 'outline:done:1', 'post:done:1', 'publish:done:1']);
    const post = await readFile(path.join(cwd, 'changelog.md'), 'utf8');
    assert.match(post, /^# Node\.js releases\n\n## Summary\n/);
    assert.ok(post.length > 600, 'the mock draft satisfies minLength(600)');
    assert.ok(lines.some((l) => l.includes('source=fixture')));
  } finally {
    if (saved === undefined) delete process.env.AWK_OFFLINE;
    else process.env.AWK_OFFLINE = saved;
  }
});

test('extract sends no mockReply, with a warning, for a schema example() cannot build — a real run is unaffected', async () => {
  const schema: Schema = { type: 'object', properties: { tag: { type: 'string', pattern: '^v\\d+' } }, required: ['tag'] };
  const llm = fakeLlm('{"tag":"v1"}');
  const c = ctx({ from: 'src', instruction: 'x', schema }, { src: 'v1' }, llm);
  const { output } = await extract.run(c);
  assert.deepEqual(output, { tag: 'v1' });
  assert.equal(llm.requests[0].mockReply, undefined);
  assert.ok(c.lines.some((l) => l.includes('warn extract: no mock reply for this schema') && l.includes('not synthesized')));
});
