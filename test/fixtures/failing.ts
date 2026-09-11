// CLI test fixture: a valid pipeline whose second step throws a NonRetryableError, so a run exits 1 naming `boom`
// and leaves a checkpoint holding `seed`, which a following --dry-run shows as skipped.
import { NonRetryableError, step, type Pipeline, type Step } from '../../src/types.js';

const constant: Step<{ value: string }, string> = {
  name: 'constant',
  async run(ctx) {
    return { output: ctx.params.value };
  },
};

const bomb: Step<undefined, never> = {
  name: 'bomb',
  async run() {
    throw new NonRetryableError('the fuse was lit');
  },
};

const pipeline: Pipeline = {
  name: 'cli-failing',
  steps: [
    step({ id: 'seed', uses: constant, params: { value: 'ok' } }),
    step({ id: 'boom', uses: bomb, params: undefined }),
  ],
};

export default pipeline;
