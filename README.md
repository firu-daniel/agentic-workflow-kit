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

LLM mode is chosen by the environment, not by a flag: with `ANTHROPIC_API_KEY` set, steps that call
the model reach the Anthropic API (`ANTHROPIC_MODEL` picks the model, default `claude-sonnet-5`, and
`ANTHROPIC_BASE_URL` is honoured by the SDK — how the tests point it at a local stub); without it an
offline mock answers every call with the step's own `mockReply` (or a canned text) and
prompt-proportional token counts, so a pipeline whose steps supply a `mockReply` runs green with no
key and no network. The log says which mode a run used (`llm mode mode=mock|anthropic`) and prints
one `llm` line per call.

A pipeline is `pipelines/<name>.ts` with a default export of `{ name, steps }` (see `src/types.ts`);
a value containing `/` is loaded as a path to such a file, resolved against the cwd (under `npm run`
that is always the package root, which is also where `runs/` lands). The checkpoint lives at
`runs/<name>.checkpoint.json` while a run is incomplete; `--fresh` discards it. `--approve` is parsed
but gates are not enforced yet. Exit code 1 names the step that failed, 2 a usage or pipeline-file
error. Log lines go to stderr, the plan and the summary to stdout.

Status: runner core done (sequential loop, per-step checkpoint and resume, retry with backoff,
dry-run, CLI) and the LLM slot filled (Anthropic SDK client and offline mock, picked by
environment). Step library and the example pipeline follow in the next commits.
