// Smoke pipeline: two inline steps, no LLM. Proves the contracts and the runner loop; the
// library steps (src/steps/) replace these inline ones once they exist.
import { NonRetryableError, step, type Pipeline, type Step } from '../src/types.js';

const constant: Step<{ value: string }, string> = {
  name: 'constant',
  async run(ctx) {
    return { output: ctx.params.value, usage: { input: 0, output: 0 } };
  },
};

const upper: Step<{ from: string }, string> = {
  name: 'upper',
  async run(ctx) {
    const src = ctx.inputs[ctx.params.from];
    if (typeof src !== 'string') throw new NonRetryableError(`input "${ctx.params.from}" is not a string`);
    ctx.log.info('upper-casing', { chars: src.length, attempt: ctx.attempt });
    return { output: src.toUpperCase(), usage: { input: 0, output: 0 } };
  },
  verify(output) {
    return output === output.toUpperCase() ? [] : ['output is not upper-case'];
  },
};

const pipeline: Pipeline = {
  name: 'smoke',
  steps: [
    step({ id: 'seed', uses: constant, params: { value: 'hello from the smoke pipeline' } }),
    step({
      id: 'shout',
      uses: upper,
      params: { from: 'seed' },
      verify: [(o) => (o.length > 0 ? [] : ['empty output'])],
      retry: { attempts: 2 },
    }),
  ],
};

export default pipeline;
