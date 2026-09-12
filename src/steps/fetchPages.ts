// `fetchPages`: HTTP GET each URL and reduce the body to text (HTML tags, scripts and styles stripped; anything else
// kept as it is), so later steps get sources they can quote and `noFabricatedUrls` has a corpus to check against.
// A fixture file per URL stands in when the request cannot succeed on a retry (no network, a timeout, a 4xx), and is
// used without a request under AWK_OFFLINE=1, so a pipeline runs green with no network (the offline mock's counterpart
// for the fetch side). A retryable status (429, 5xx, 408, 409) is thrown past the fixture instead, so the runner backs
// off and the run gets the live page rather than a stale snapshot.
import { readFile } from 'node:fs/promises';
import { isRetryableStatus } from '../llm.js';
import { errorText } from '../log.js';
import { bareUrl } from './shared.js';
import { NonRetryableError } from '../types.js';
import type { Step } from '../types.js';

export interface FetchPagesParams {
  urls: string[];
  /** URL → path of a file holding the page body (resolved against the cwd), used when the request cannot succeed on a
   * retry (a network or DNS failure, a timeout, a status outside 429/5xx/408/409) and, under AWK_OFFLINE=1, instead of
   * any request; a retryable status is thrown so the runner retries. A fixture is reduced to text like a fetched body. */
  fixtures?: Record<string, string>;
  /** Per-page character cap on the text; default DEFAULT_PAGE_CHARS. */
  maxChars?: number;
  /** Per-request wall-clock cap; default DEFAULT_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Extra request headers (an `Accept`, a token). */
  headers?: Record<string, string>;
}

export interface FetchedPage {
  url: string;
  /** The HTML `<title>`, else the URL. */
  title: string;
  text: string;
  source: 'http' | 'fixture';
}

export const DEFAULT_PAGE_CHARS = 40_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
/** Sent on every request so a site sees who is asking. */
export const USER_AGENT = 'agentic-workflow-kit/0.1 (+https://github.com/firu-daniel/agentic-workflow-kit)';

/** The `fetch` the step uses; tests inject one. */
export type Fetch = typeof globalThis.fetch;

export interface FetchPagesDeps {
  fetch?: Fetch;
  env?: NodeJS.ProcessEnv;
}

/** `fetchPages` with an injected `fetch` / env; the exported `fetchPages` is the default binding. */
export function fetchPagesWith(deps: FetchPagesDeps = {}): Step<FetchPagesParams, FetchedPage[]> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  return {
    name: 'fetchPages',
    async run(ctx) {
      const { urls, fixtures = {}, maxChars = DEFAULT_PAGE_CHARS, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, headers } = ctx.params;
      if (!urls.length) throw new NonRetryableError('fetchPages: no urls');
      const offline = env.AWK_OFFLINE === '1';
      const pages: FetchedPage[] = [];
      for (const url of urls) {
        const fixture = fixtures[url];
        if (offline) {
          if (!fixture) throw new NonRetryableError(`fetchPages: AWK_OFFLINE=1 and no fixture for ${url}`);
          pages.push(await fromFixture(url, fixture, maxChars));
          ctx.log.info('fetched', { step: ctx.stepId, url, source: 'fixture', chars: pages.at(-1)!.text.length, reason: 'AWK_OFFLINE' });
          continue;
        }
        const started = Date.now();
        try {
          const res = await doFetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
          const body = await res.text();
          if (!res.ok) {
            // A retryable status is worth a wait; any other one would answer the same way again.
            const message = `fetchPages: ${url} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
            throw isRetryableStatus(res.status) ? new RetryableStatus(message) : new NonRetryableError(message);
          }
          const page = toPage(url, body, res.headers.get('content-type') ?? '', maxChars, 'http');
          pages.push(page);
          ctx.log.info('fetched', { step: ctx.stepId, url, source: 'http', status: res.status, ms: Date.now() - started, chars: page.text.length });
        } catch (err) {
          // A retryable status must reach the runner: falling back here would report a stale fixture as a fresh page.
          if (err instanceof RetryableStatus || !fixture) throw err;
          pages.push(await fromFixture(url, fixture, maxChars));
          ctx.log.warn('fetched', { step: ctx.stepId, url, source: 'fixture', chars: pages.at(-1)!.text.length, reason: errorText(err) });
        }
      }
      return { output: pages };
    },
    verify(pages) {
      return pages.flatMap((p) => (p.text.trim() ? [] : [`${p.url}: empty page text`]));
    },
  };
}

export const fetchPages = fetchPagesWith();

/** A status the runner should back off and retry; a plain Error to it, and the one failure the fixture does not cover. */
class RetryableStatus extends Error {}

async function fromFixture(url: string, file: string, maxChars: number): Promise<FetchedPage> {
  let body: string;
  try {
    body = await readFile(file, 'utf8');
  } catch (err) {
    throw new NonRetryableError(`fetchPages: fixture for ${url} cannot be read: ${errorText(err)}`, { cause: err });
  }
  return toPage(url, body, /\.html?$/i.test(file) ? 'text/html' : '', maxChars, 'fixture');
}

function toPage(url: string, body: string, contentType: string, maxChars: number, source: FetchedPage['source']): FetchedPage {
  const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
  const title = (isHtml && /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim()) || url;
  const text = isHtml ? htmlToText(body) : body.trim();
  return { url, title: decodeEntities(title), text: text.length > maxChars ? `${text.slice(0, maxChars)}\n[… cut at ${maxChars} characters]` : text, source };
}

/** The head (title included), scripts, styles and tags dropped; block-level tags become line breaks; the common named
 * entities and all numeric references decoded; whitespace collapsed to single spaces within a line and at most one
 * blank line between blocks. An `<a>` with an absolute http(s) target keeps it — `text (https://x.y/z)` — so a later
 * step can cite the page's links instead of inventing them. Good enough for prose; tables flatten. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|script|style|noscript|template|svg|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, keepLinkTarget)
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|footer|nav|blockquote|pre|dd|dt|dl|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `<a href="https://x.y/z">text</a>` → `text (https://x.y/z)`. A relative, protocol-relative (`//host/path`), `#`,
 * `javascript:`, `mailto:` or `tel:` target is dropped, and so is one the anchor text already spells out (compared as
 * `verify` compares URLs, so `x.io/z` and `https://x.io/z/` do not double). The attribute name is anchored, or a
 * `data-href` would win over the real target. */
function keepLinkTarget(_match: string, attrs: string, inner: string): string {
  const quoted = /(?:^|[\s"'])href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  const href = decodeEntities(quoted?.slice(1).find((v) => v !== undefined) ?? '').trim();
  if (!/^https?:\/\//i.test(href)) return inner;
  const text = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return bareUrl(text) === bareUrl(href) ? inner : `${inner} (${href})`;
}

/** The named entities worth a table; every other one (`&rsquo;`, `&times;`) survives literally. */
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[code.toLowerCase()] ?? m;
  });
}
