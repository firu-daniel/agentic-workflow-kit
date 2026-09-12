# agentic-workflow-kit

A small TypeScript runner for multi-step agentic workflows. One pipeline is one file under
`pipelines/`: an ordered list of steps from a shared step library, each with its prompt or
parameters and its verification rules. The runner executes the steps in order, checkpoints after
each one so a re-run resumes at the first step not completed, retries with backoff, stops for a
human before any step marked as a gate, and can run fully offline against a mock LLM.

## How to run

Requires Node 20+. No build step (runs through `tsx`).

```sh
npm install
AWK_OFFLINE=1 AWK_LLM=mock npm run start -- --pipeline example-changelog             # five library steps, fixture + mock, no network; stops at the gate (exit 3)
AWK_OFFLINE=1 AWK_LLM=mock npm run start -- --pipeline example-changelog --approve   # resumes from the checkpoint, writes out/changelog.md and runs/<timestamp>.md
npm run start -- --pipeline example-changelog                                        # the same against GitHub and the selected LLM
npm run start -- --pipeline smoke --dry-run                                          # the plan for a run; no step is called
npm run start -- --pipeline smoke --fresh                                            # discard the checkpoint, run every step again
npm test                                                                             # 121 tests, offline
npm run typecheck                                                                    # tsc --noEmit
```

Flags: `--pipeline <name>` (required; a value containing `/` is a path to a pipeline file, resolved against the
cwd — under `npm run` that is the package root), `--dry-run`, `--approve`, `--fresh`. The LLM mode comes from
the environment, not from a flag (see below). Exit code 0 is a completed run, a dry run or `--help`; 1 names the
step that failed after its retries, or a run that threw outside a step; 2 a usage or pipeline-file error; 3 a
gate waiting for approval. Log lines go to stderr, the plan and the summary to stdout; the summary names the run's
report.

## The steps

`pipelines/example-changelog.ts` is the demo: the latest Node.js releases from the GitHub API → structured
facts → outline → changelog post (≥ 600 chars, no URL outside the sources) → `out/changelog.md`. Its five steps
are the whole library (`src/steps/`):

| Step | Does | Fails verify when |
|---|---|---|
| `fetchPages` | HTTP GET each URL, HTML → text (title kept); a per-URL fixture file stands in when the request cannot succeed on a retry (no network, a timeout, a status outside 429/5xx/408/409), and replaces it under `AWK_OFFLINE=1` | a page is empty |
| `extract` | one LLM call → JSON matching a small JSON-schema subset (`src/steps/schema.ts`) | the answer is not JSON, or violates the schema (each violation by path) |
| `plan` | one LLM call → a markdown outline with the requested `## ` sections | the output is empty, or a requested section has no heading (any level) |
| `draft` | one LLM call → the markdown piece, from whichever earlier steps its `from` names | the output is empty, or a requested section has no heading (any level) |
| `emit` | writes the output under `out/` (the run's artifact); with `GITHUB_TOKEN` and a `pr` param, opens a PR with the file (branch from base, put file, open or find the PR — re-run safe) | — |

Pipeline-level rules attach to the step whose output they check: `minLength(n)`, `maxLength(n)`,
`requiredSections([...])`, `noFabricatedUrls(from, allow?)` (every URL in the output must appear in the named
steps' outputs, or in `allow`) and `matchesSchema(schema)`. The demo checks the draft's URLs against the fetched
pages rather than the extract that named them, so no step between page and post can widen the corpus. A step's
own `verify` runs first, then the pipeline's rules; any failure string fails the attempt, and the next attempt
receives those strings as its correction.

A pipeline is `pipelines/<name>.ts` with a default export of `{ name, steps }` (see `src/types.ts`); each step
names the earlier steps it reads through its `from` param. `pipelines/smoke.ts` is the three-step, no-LLM
version that exercises the loop, one verify failure and one retry.

## Where a run leaves things

| File | What | Lifetime |
|---|---|---|
| `runs/<name>.checkpoint.json` | every completed step's output, keyed by step id | while the run is incomplete; a completed run or `--fresh` removes it |
| `runs/<name>.review.md` | what a gated step would do and consume, the completed steps, how to re-run | from the gate stop until the `--approve` run reaches the step; a completed run or `--fresh` clears it too |
| `runs/<timestamp>.md` | the run report: one line per step (status, attempts, ms, tokens, error, artifact), the totals, the final artifact, and why a run stopped | kept; never removed by the runner |
| `out/<path>` | the artifact an `emit` step writes | kept |

Both directories are relative to the cwd — under `npm run start` that is the package root — and are git-ignored
except for their `.gitkeep`.

The report is the evidence a run leaves behind: every run that is not a dry run writes one at the end, whatever
the outcome — a completed run, a step failure, a gate, and a run that threw outside a step, which is reported and
then rethrown; only a dry run writes none — and the summary line names it. It is a page of markdown — under 30
lines for a five-step pipeline — meant to be pasted as it is:

```
# Run 2026-09-12T09-49-20-908Z: example-changelog ok

Started 2026-09-12T09:49:20.908Z, 2 ms wall clock with --approve; 5 steps (4 resumed, 0 retries), tokens in/out 0/0.

| # | step | uses | status | attempts | ms | tokens in/out | error | artifact |
|---|---|---|---|---|---|---|---|---|
| 1 | releases | fetchPages | resumed | 0 | 0 | 0/0 |  |  |
| 2 | facts | extract | resumed | 0 | 0 | 0/0 |  |  |
| 3 | outline | plan | resumed | 0 | 0 | 0/0 |  |  |
| 4 | post | draft | resumed | 0 | 0 | 0/0 |  |  |
| 5 | publish | emit | done | 1 | 1 | 0/0 |  | out/changelog.md |

Artifact: out/changelog.md
```

A failed run's report ends with a `Failed:` line carrying the step, its attempts and the error; a gated run's
with a `Gated:` line naming the review file; a run that threw outside a step with a `Stopped:` line carrying that
error. `Artifact:` names the last artifact a step wrote, so a gated run reads `none` unless an earlier step
produced one — the review file is run state, and the `Gated:` line is where it belongs. The table's error cell is
cut at 200 characters, the closing line at 2000, and both escape what they carry, so nothing inside an error can
open a row or a line of its own. A report that cannot be written is a warning in the log, not a failed run.

## Design choices

**Checkpoint per step, not per run.** The LLM steps are the slow and paid part of a pipeline, and each
step's output is exactly what the later steps consume by id, so a step is the natural unit of resume. A failure
at step four re-runs step four, not the three calls before it, and the same store is what lets a gate stop the
run and an `--approve` run continue it later. The cost is one JSON write per step and one blind spot: the
checkpoint fingerprints the step list (ids and library-step names) and ignores itself with a warning when that
changes, so adding or reordering a step is safe, but a changed prompt, param or step body under the same id goes
undetected and needs `--fresh`.

**Deterministic verify before any model judges.** Every rule in the kit is code: a section header present,
a length bound, a schema walk, every URL traced back to a fetched page. Code rules are free, exact and
reproducible, and their failure text is a concrete correction ("missing section Links", "URL x not in
sources") that the retry hands to the model — an LLM judge costs a call, can be wrong in either direction, and
returns an opinion, not a diff. A judge step, when one is wanted, is one more `verify` rule — a rule gets the
whole step context, `llm` included — placed last, since rules run in array order; never instead of the code
rules. The two failure kinds retry differently on purpose: a verify failure is a content problem, so the retry is
immediate and carries the correction; a thrown error (429, 5xx, timeout) is a transport problem, so the retry
waits `baseDelayMs · 2^(n-2)` before attempt *n* — three attempts, 1 s then 2 s by default (`DEFAULT_RETRY`),
uncapped and overridable per step. A `NonRetryableError` ends the loop at once: the failure no retry can change.
The transport cases are the obvious ones (a status outside 429/5xx/408/409, a `maxTokens` cut-off the same cap
would repeat), but any step throws it for a pipeline mistake a model cannot fix either — a `from` naming no
earlier step, an `emit` path leaving `out/`, a schema `pattern` that does not compile.

**Mock mode is the default when nothing else is configured.** The pipeline's structure — step ids, `from`
wiring, verify rules, the gate, the checkpoint — is most of what can go wrong, and none of it needs a model to
test. Each LLM-backed step (`extract`, `plan`, `draft`) supplies a `mockReply` that satisfies its own
verify rules; `fetchPages` and `emit` call no model, so `AWK_OFFLINE=1` and a local write cover them. `npm test`
and a whole pipeline both go green with no key and the wifi off, and a pipeline author never writes a mock. The
mock estimates tokens at four characters each, so the `step` and `llm` lines and the review file's table read like
a real run's instead of a column of zeros. `extract`'s reply is built from its schema; a schema `example()` cannot
build (a `pattern` outside an enum) logs a warning and drops back to the canned text, so that one step fails verify
legibly offline — a real run is unaffected.

**A gate is a step attribute, not a separate mechanism.** `gate: true` on a step (the demo's `publish`) makes
the runner stop before it, write the review file with the step's params and the outputs it would consume (each
clipped at 100k characters), and exit 3 — a stop, not an error. The flag is never stored, but its result is: an
approved step that reached the checkpoint resumes like any other, so a re-run gates only on a step that has not
completed. A completed run clears the checkpoint, so the demo gates from scratch next time.

**One pipeline is one file, and the runner core is 200 lines.** Writing a new workflow means writing one
declarative file against a fixed step library: the demo pipeline is 79 lines and imports five steps. The core
(`src/runner.ts`) is 200 lines, with the checkpoint store, the review writer and the run report split out of it
(`src/log.ts` is shared by every module, not a runner split: the logger, plus the value rendering — `toText`,
`prettyText`, `errorText` — and the markdown `cell` and `clip` the review file and the report write with). The
budget is a habit, not a CI check — if it starts slipping, that is the signal the runner is taking on work the
step library should own.

## LLM modes and environment

`AWK_LLM` names the mode when set:

- `claude-code` — the installed Claude Code CLI in headless mode (`claude -p`, tools off, one
  turn, `--no-session-persistence`, `--safe-mode` and `--strict-mcp-config` so the machine's own
  Claude Code configuration stays out of the call, and always a `--system-prompt` — the step's,
  else a neutral default — so the call never inherits Claude Code's own agent prompt). It runs
  through the CLI's own login: a Claude subscription, or `ANTHROPIC_API_KEY` if that is set in the
  environment, which the CLI prefers. A step's `maxTokens` does not apply here — the CLI has no
  output-cap flag — and the `llm` line logs the API-equivalent cost the CLI reports, which counts
  the CLI's auxiliary model calls whose tokens are outside the `in=`/`out=` counts. Finding and
  spawning `claude` is POSIX-only: no `PATHEXT` / `.cmd` handling.
- `anthropic` — the Anthropic API through the official SDK, billed to `ANTHROPIC_API_KEY`
  (`ANTHROPIC_BASE_URL` is honoured — how the tests point it at a local stub).
- `mock` — the offline mock described above.

Unset, the mode follows what is available: `ANTHROPIC_API_KEY` set → `anthropic`, else `claude` on
`PATH` → `claude-code`, else `mock`. `AWK_LLM=claude-code` with no `claude` on `PATH` is a usage
error (exit 2), not a fallback. Both real modes take the model from `ANTHROPIC_MODEL` (default
`claude-sonnet-5`). The log says which mode a run used and why (`llm mode mode=… reason=…`) and
prints one `llm` line per call. A retryable status (429, 5xx, 408, 409 — one classification,
`isRetryableStatus`, read by both LLM backends, `fetchPages` and `emit`'s GitHub calls — plus a
GitHub 403 carrying a rate-limit signal) throws and is retried with a wait, past any fixture
configured for the URL.

Three more variables shape a run: `AWK_OFFLINE=1` makes `fetchPages` read each URL's configured fixture file
instead of requesting it (a URL with no fixture then fails), so a run needs no network. `GITHUB_TOKEN` lets an
`emit` step with a `pr` param open the pull request — without it the PR is skipped and the written file is the
deliverable — and `GITHUB_API_URL` points those GitHub calls elsewhere (default `https://api.github.com`).

## Status

Runner core (sequential loop, per-step checkpoint and resume, retry with backoff, dry-run, CLI), the LLM slot
(Claude Code CLI, Anthropic SDK client and offline mock, picked by environment), the step library, the example
pipeline, the approval gate and the per-run report are in.
