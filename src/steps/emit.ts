// `emit`: writes a step's output as markdown under out/ (the run's artifact) and, when `pr` is set and GITHUB_TOKEN
// is in the environment, opens a pull request on GitHub with the file at the same path: branch from the base, put
// the file (created or updated), open the PR — or return the one already open for that branch. The GitHub calls go
// through `fetch` against GITHUB_API_URL (default https://api.github.com), which is how the tests stand it in.
// Without a token the PR is skipped with a log line, not an error: the file on disk is the deliverable either way.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isRetryableStatus } from '../llm.js';
import { errorText } from '../log.js';
import { NonRetryableError } from '../types.js';
import type { Logger, Step } from '../types.js';
import { asText } from './shared.js';

export interface EmitParams {
  /** The step whose output to write; a string as it is, anything else as pretty JSON. */
  from: string;
  /** File path, relative to `dir` (default out/); also the path of the file in the PR. Must name a file that stays
   * under `dir`: a path leaving it, or one naming a directory, is a NonRetryableError. */
  path: string;
  /** Prepended as `# <title>` when the content has no top-level heading. */
  title?: string;
  /** Output directory; default out/. */
  dir?: string;
  pr?: {
    /** `owner/name` */
    repo: string;
    /** Head branch to create (or reuse) for the PR. */
    branch: string;
    /** Base branch; the repository's default branch when unset. */
    base?: string;
    title?: string;
    body?: string;
    commitMessage?: string;
  };
}

export interface EmitOutput {
  path: string;
  bytes: number;
  /** Present when a PR was opened or found. */
  pr?: { url: string; number: number; branch: string; created: boolean };
}

export const DEFAULT_OUT_DIR = 'out';
export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';

export interface EmitDeps {
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
}

/** `emit` with an injected `fetch` / env; the exported `emit` is the default binding. */
export function emitWith(deps: EmitDeps = {}): Step<EmitParams, EmitOutput> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  return {
    name: 'emit',
    async run(ctx) {
      const { from, title, dir = DEFAULT_OUT_DIR, pr } = ctx.params;
      if (!(from in ctx.inputs)) throw new NonRetryableError(`emit: input "${from}" is not the output of an earlier step`);
      const rel = path.normalize(ctx.params.path);
      // "" and "sub/" name a directory: writeFile would throw EISDIR on every attempt, backoff included.
      if (!path.basename(rel) || path.basename(rel) === '.' || rel.endsWith(path.sep)) throw new NonRetryableError(`emit: path must name a file: "${ctx.params.path}"`);
      // Resolved, so a file legitimately named "..cache.md" passes and only a path that leaves dir/ is refused.
      const root = path.resolve(dir);
      if (!path.resolve(root, rel).startsWith(root + path.sep)) throw new NonRetryableError(`emit: path must stay under ${dir}/: ${ctx.params.path}`);
      let content = asText(ctx.inputs[from]).trim();
      if (title && !/^#\s/.test(content)) content = `# ${title}\n\n${content}`;
      content = `${content}\n`;
      const file = path.join(dir, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      const bytes = Buffer.byteLength(content);
      ctx.log.info('emitted', { step: ctx.stepId, file, bytes });
      const output: EmitOutput = { path: file, bytes };
      if (pr) {
        const token = env.GITHUB_TOKEN;
        if (!token) {
          ctx.log.warn('pr skipped', { step: ctx.stepId, repo: pr.repo, reason: 'GITHUB_TOKEN is not set' });
        } else {
          output.pr = await openPr({ ...pr, filePath: rel.split(path.sep).join('/'), content, token, api: env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL, fetch: doFetch, log: ctx.log, step: ctx.stepId });
        }
      }
      return { output, artifact: file };
    },
  };
}

export const emit = emitWith();

/** GitHub answers 403, not 429, for a secondary or unauthenticated rate limit, and says so in a `retry-after` or an
 * exhausted `x-ratelimit-remaining`: the one 403 a wait fixes. */
const isRateLimited = (res: Response): boolean =>
  res.status === 403 && (res.headers.get('retry-after') !== null || res.headers.get('x-ratelimit-remaining') === '0');

interface PrArgs extends NonNullable<EmitParams['pr']> {
  filePath: string;
  content: string;
  token: string;
  api: string;
  fetch: typeof globalThis.fetch;
  log: Logger;
  step: string;
}

/** Branch from the base (reused when it exists), create or update the file on it, open the PR (or find the open
 * one for that head). Statuses: a retryable one (429, 5xx, 408, 409 — `isRetryableStatus`), and a 403 carrying a
 * rate-limit signal, throw a plain Error (the step retries with a wait; every call is idempotent on re-run); any
 * other failure is a NonRetryableError with GitHub's message. */
async function openPr(a: PrArgs): Promise<NonNullable<EmitOutput['pr']>> {
  const repo = `${a.api}/repos/${a.repo}`;
  const call = async (method: string, url: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; json: any }> => {
    const res = await a.fetch(url, {
      method,
      headers: { authorization: `Bearer ${a.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text };
    }
    if (res.ok || okStatuses.includes(res.status)) return { status: res.status, json };
    const message = `github: ${method} ${url.slice(a.api.length)} answered ${res.status}: ${errorText(json?.message ?? text)}`;
    throw isRetryableStatus(res.status) || isRateLimited(res) ? new Error(message) : new NonRetryableError(message);
  };
  const [owner] = a.repo.split('/');
  const base = a.base ?? (await call('GET', repo)).json.default_branch;
  if (typeof base !== 'string' || !base) throw new NonRetryableError(`github: cannot resolve the default branch of ${a.repo}`);
  // Per segment: a base branch named "release/1.x" is a path in this URL, not one escaped component.
  const sha = (await call('GET', `${repo}/git/ref/heads/${base.split('/').map(encodeURIComponent).join('/')}`)).json.object?.sha;
  if (typeof sha !== 'string') throw new NonRetryableError(`github: base branch "${base}" has no sha`);
  // 422 = the branch exists already (a re-run): reuse it.
  const ref = await call('POST', `${repo}/git/refs`, { ref: `refs/heads/${a.branch}`, sha }, [422]);
  a.log.info('pr branch', { step: a.step, branch: a.branch, base, created: ref.status !== 422 });
  const contentsUrl = `${repo}/contents/${a.filePath.split('/').map(encodeURIComponent).join('/')}`;
  const existing = await call('GET', `${contentsUrl}?ref=${encodeURIComponent(a.branch)}`, undefined, [404]);
  const fileSha = existing.status === 404 ? undefined : existing.json.sha;
  await call('PUT', contentsUrl, {
    message: a.commitMessage ?? `docs: ${a.filePath}`,
    content: Buffer.from(a.content).toString('base64'),
    branch: a.branch,
    ...(typeof fileSha === 'string' ? { sha: fileSha } : {}),
  });
  const open = await call('GET', `${repo}/pulls?head=${encodeURIComponent(`${owner}:${a.branch}`)}&base=${encodeURIComponent(base)}&state=open`);
  let pr = Array.isArray(open.json) ? open.json[0] : undefined;
  const created = !pr;
  if (!pr) {
    pr = (await call('POST', `${repo}/pulls`, { title: a.title ?? `Add ${a.filePath}`, body: a.body ?? '', head: a.branch, base })).json;
  }
  if (typeof pr?.html_url !== 'string' || typeof pr?.number !== 'number') throw new NonRetryableError('github: the pull request answer has no html_url / number');
  a.log.info('pr', { step: a.step, url: pr.html_url, number: pr.number, created });
  return { url: pr.html_url, number: pr.number, branch: a.branch, created };
}
