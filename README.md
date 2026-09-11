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

A pipeline is `pipelines/<name>.ts` with a default export of `{ name, steps }` (see `src/types.ts`);
a value containing `/` is loaded as a path to such a file, resolved against the cwd (under `npm run`
that is always the package root, which is also where `runs/` lands). The checkpoint lives at
`runs/<name>.checkpoint.json` while a run is incomplete; `--fresh` discards it. `--approve` is parsed
but gates are not enforced yet. Exit code 1 names the step that failed, 2 a usage or pipeline-file
error. Log lines go to stderr, the plan and the summary to stdout.

Status: runner core done (sequential loop, per-step checkpoint and resume, retry with backoff,
dry-run, CLI). LLM client, step library and the example pipeline follow in the next commits.
