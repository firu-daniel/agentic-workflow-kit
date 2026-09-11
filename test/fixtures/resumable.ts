// CLI test fixture: a valid pipeline whose second step throws a NonRetryableError until AWK_TEST_PASS=1 is set (a
// plain Error would retry with real backoff), so a first run exits 1 leaving a checkpoint holding `seed`, and a
// re-run in the same cwd with the variable set resumes that step and completes all three.
import { NonRetryableError, step, type Pipeline, type Step } from '../../src/types.js';

const constant: Step<{ value: string }, string> = {
  name: 'constant',
  async run(ctx) {
    return { output: ctx.params.value };
  },
};

const flaky: Step<undefined, string> = {
  name: 'flaky',
  async run() {
    if (process.env.AWK_TEST_PASS !== '1') throw new NonRetryableError('AWK_TEST_PASS is not set');
    return { output: 'repaired' };
  },
};

const pipeline: Pipeline = {
  name: 'cli-resumable',
  steps: [
    step({ id: 'seed', uses: constant, params: { value: 'ok' } }),
    step({ id: 'flaky', uses: flaky, params: undefined }),
    step({ id: 'tail', uses: constant, params: { value: 'done' } }),
  ],
};

export default pipeline;
