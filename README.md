# agentic-workflow-kit

A small TypeScript runner for multi-step agentic workflows. One pipeline is one file under
`pipelines/`: an ordered list of steps from a shared step library, each with its prompt or
parameters and its verification rules. The runner executes the steps in order, checkpoints after
each one so a re-run resumes at the failed step, retries with backoff, and can run fully offline
against a mock LLM.

Requires Node 20+. No build step (runs through `tsx`).

```sh
npm install
AWK_OFFLINE=1 AWK_LLM=mock npm run start -- --pipeline example-changelog   # five library steps, fixture + mock, no network
npm run start -- --pipeline example-changelog                              # the same against GitHub and the selected LLM
npm run start -- --pipeline smoke --dry-run                                # the plan for a run; no step is called
npm test
```

## Step library (`src/steps/`)

| Step | Does | Fails verify when |
|---|---|---|
| `fetchPages` | HTTP GET each URL, HTML → text (title kept); a per-URL fixture file stands in when the request cannot succeed on a retry (no network, a timeout, a 4xx), and replaces it under `AWK_OFFLINE=1` | a page is empty |
| `extract` | one LLM call → JSON matching a small JSON-schema subset (`src/steps/schema.ts`) | the answer is not JSON, or violates the schema (each violation by path) |
| `plan` | one LLM call → a markdown outline with the requested `## ` sections | a section is missing |
| `draft` | one LLM call → the markdown piece from sources, facts and outline | a section is missing |
| `emit` | writes the output under `out/` (the run's artifact); with `GITHUB_TOKEN` and a `pr` param, opens a PR with the file (branch from base, put file, open or find the PR — re-run safe) | — |

Verify rules attach to the step whose output they check, so a failure retries that step with the exact failure
text as the correction: `minLength(n)`, `maxLength(n)`, `requiredSections([...])`, `noFabricatedUrls(fromStepIds)`
(every URL in the output must appear in the named steps' outputs) and `matchesSchema(schema)`. Code verifies before any
model judges. Each LLM step supplies a `mockReply` that passes its own verify, so the mock mode runs green;
`extract`'s is generated from the schema, which must be one an example can be built for (a `pattern` outside an enum
is not synthesized and is refused). A retryable status (429, 5xx, 408, 409 — one classification, shared with the
Anthropic client — plus a GitHub 403 carrying a rate-limit signal) throws and is retried with a wait, past any fixture
configured for the URL; any other 4xx is `NonRetryableError`. An LLM answer cut short at `maxTokens` is one too: the
same cap would cut the retry the same way.

`pipelines/example-changelog.ts` is the demo: the latest Node.js releases from the GitHub API → structured facts →
outline → changelog post (≥ 600 chars, no URL outside the sources) → `out/changelog.md`.

LLM mode is chosen by the environment, not by a flag. `AWK_LLM` names it when set:

- `claude-code` — the installed Claude Code CLI in headless mode (`claude -p`, tools off, one turn,
  `--safe-mode` and `--strict-mcp-config` so the machine's own Claude Code configuration stays out of
  the call). It runs through the CLI's own login: a Claude subscription, or `ANTHROPIC_API_KEY` if
  that is set in the environment, which the CLI prefers. A step's `maxTokens` does not apply here —
  the CLI has no output-cap flag — and the `llm` line logs the API-equivalent cost the CLI reports,
  which counts the CLI's auxiliary model calls whose tokens are outside the `in=`/`out=` counts.
  Finding and spawning `claude` is POSIX-only: no `PATHEXT` / `.cmd` handling.
- `anthropic` — the Anthropic API through the official SDK, billed to `ANTHROPIC_API_KEY`
  (`ANTHROPIC_BASE_URL` is honoured — how the tests point it at a local stub).
- `mock` — an offline mock answers every call with the step's own `mockReply` (or a canned text)
  and prompt-proportional token counts, so a pipeline whose steps supply a `mockReply` runs green
  with no key and no network.

Unset, the mode follows what is available: `ANTHROPIC_API_KEY` set → `anthropic`, else `claude` on
`PATH` → `claude-code`, else `mock`. `AWK_LLM=claude-code` with no `claude` on `PATH` is a usage
error (exit 2), not a fallback. Both real modes take the model from `ANTHROPIC_MODEL` (default
`claude-sonnet-5`). The log says which mode a run used and why (`llm mode mode=… reason=…`) and
prints one `llm` line per call.

Three more variables shape a run: `AWK_OFFLINE=1` makes `fetchPages` read each URL's configured fixture file instead
of requesting it (a URL with no fixture then fails), so a run needs no network. `GITHUB_TOKEN` lets an `emit` step
with a `pr` param open the pull request — without it the PR is skipped and the written file is the deliverable — and
`GITHUB_API_URL` points those GitHub calls elsewhere (default `https://api.github.com`).

A pipeline is `pipelines/<name>.ts` with a default export of `{ name, steps }` (see `src/types.ts`);
a value containing `/` is loaded as a path to such a file, resolved against the cwd (under `npm run`
that is always the package root, which is also where `runs/` lands). The checkpoint lives at
`runs/<name>.checkpoint.json` while a run is incomplete; `--fresh` discards it. `--approve` is parsed
but gates are not enforced yet. Exit code 1 names the step that failed, 2 a usage or pipeline-file
error. Log lines go to stderr, the plan and the summary to stdout.

Status: runner core done (sequential loop, per-step checkpoint and resume, retry with backoff,
dry-run, CLI), the LLM slot filled (Claude Code CLI, Anthropic SDK client and offline mock,
picked by environment), the step library and the example pipeline in. The approval gate and the
per-run report follow.
