// CLI test fixture: a valid pipeline whose second step is gated, so a run without --approve exits 3 leaving a
// checkpoint holding `seed` and a review file, and a re-run in the same cwd with --approve completes all three.
import { step, type Pipeline, type Step } from '../../src/types.js';

const constant: Step<{ value: string }, string> = {
  name: 'constant',
  async run(ctx) {
    return { output: ctx.params.value };
  },
};

const pipeline: Pipeline = {
  name: 'cli-gated',
  steps: [
    step({ id: 'seed', uses: constant, params: { value: 'ok' } }),
    step({ id: 'publish', uses: constant, params: { value: 'published' }, gate: true }),
    step({ id: 'tail', uses: constant, params: { value: 'done' } }),
  ],
};

export default pipeline;
