# Workflow design note

(not pasted) Five items to paste next to the repo link and the run report. Item 1 is typed during
the test against the actual question; items 2–5 describe the kit as pushed, and only change where
the live pipeline deviates from the example (a step dropped, no gate, a different verify rule).

1. **Goal.** [Live: one sentence — what this pipeline produces, for whom, and from which sources.]
   One file does it: `pipelines/<name>.ts` lists the steps in order with their params and verify
   rules; a 200-line loop (`src/runner.ts`) runs them; checkpoint, gate and report each have their
   own file.

2. **Steps.** Five pre-built library steps, none written for this test: `fetchPages` (GET,
   HTML→text, a fixture per URL for offline runs and dead requests) → `extract` (one call, JSON
   against a schema) → `plan` (an outline over the sections the pipeline names) → `draft` (the
   piece) → `emit` (a file under `out/`; a PR too, given a `pr` param and `GITHUB_TOKEN`, which the
   demo leaves out). A step reads earlier outputs through `from`, so the wiring is in the pipeline
   file, not in code.

3. **Failure handling.** Verify rules are code and run before any model: length bounds, required
   sections, a schema walk, every URL in the draft traced to a fetched page. A verify failure
   re-runs the step at once with the failures as the correction; a thrown 429/5xx/timeout backs off
   (3 attempts, 1 s then 2 s); a `NonRetryableError` stops the run. Each step checkpoints, so a
   re-run resumes where it stopped. `publish` is gated: exit 3 and `runs/<name>.review.md` until
   `--approve`.

4. **Cost control.** Three of the five steps call a model, once per attempt; the fetch and the
   write are code. A resumed run pays only for steps that did not complete, and every retry carries
   the exact correction. Backend from the environment, not the code: `AWK_LLM` if set, else
   `ANTHROPIC_API_KEY` → the SDK, else `claude` on PATH → the subscription, else the free mock.
   Every call logs its tokens; the report gives per-step rows and a run total.

5. **With a week.** An LLM judge as one more verify rule after the code rules (the hook is there,
   no judge rule written); prompts and params in the checkpoint fingerprint, so an edited step
   invalidates itself (today that needs `--fresh`); concurrent fetch with a per-source cache; the
   report posted on the PR, so the gate is an ordinary PR review; an eval set to catch a prompt
   change that regresses.
