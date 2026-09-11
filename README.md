# agentic-workflow-kit

A small TypeScript runner for multi-step agentic workflows. One pipeline is one file under
`pipelines/`: an ordered list of steps from a shared step library, each with its prompt or
parameters and its verification rules. The runner executes the steps in order, checkpoints after
each one so a re-run resumes at the failed step, retries with backoff, and can run fully offline
against a mock LLM.

Requires Node 20+. No build step (runs through `tsx`).

```sh
npm install
npm run start -- --pipeline example-changelog --dry-run
```

Status: scaffold. Runner, LLM client, step library and the example pipeline follow in the next
commits.
