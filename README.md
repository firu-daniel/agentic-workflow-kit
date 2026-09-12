# agentic-workflow-kit

A small TypeScript runner for multi-step agentic workflows. One pipeline is one file under
`pipelines/`: an ordered list of steps from a shared step library, each with its prompt or
parameters and its verification rules. The runner executes the steps in order, checkpoints after
each one so a re-run resumes at the failed step, retries with backoff, and can run fully offline
against a mock LLM.

Requires Node 20+. No build step (runs through `tsx`).

```sh
npm install
npm run start -- --pipeline smoke            # three inline steps, no LLM, one self-correcting retry
npm run start -- --pipeline smoke --dry-run  # the plan for that run; no step is called
npm test
```

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

A pipeline is `pipelines/<name>.ts` with a default export of `{ name, steps }` (see `src/types.ts`);
a value containing `/` is loaded as a path to such a file, resolved against the cwd (under `npm run`
that is always the package root, which is also where `runs/` lands). The checkpoint lives at
`runs/<name>.checkpoint.json` while a run is incomplete; `--fresh` discards it. `--approve` is parsed
but gates are not enforced yet. Exit code 1 names the step that failed, 2 a usage or pipeline-file
error. Log lines go to stderr, the plan and the summary to stdout.

Status: runner core done (sequential loop, per-step checkpoint and resume, retry with backoff,
dry-run, CLI) and the LLM slot filled (Claude Code CLI, Anthropic SDK client and offline mock,
picked by environment). Step library and the example pipeline follow in the next commits.
