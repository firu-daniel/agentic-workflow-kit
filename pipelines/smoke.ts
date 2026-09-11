// Smoke pipeline: three inline steps, no LLM. Proves the contracts, the runner loop and one retry
// with verify feedback; the library steps (src/steps/) replace these inline ones once they exist.
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

/** Returns its input unchanged on the first attempt, so `verify` fails once, and fixes it on the retry by reading
 * `previousFailures` — the same way an LLM-backed step corrects itself instead of repeating its output. */
const exclaim: Step<{ from: string }, string> = {
  name: 'exclaim',
  async run(ctx) {
    const src = String(ctx.inputs[ctx.params.from]);
    if (ctx.previousFailures.length) ctx.log.info('correcting', { attempt: ctx.attempt, failures: ctx.previousFailures });
    return { output: ctx.previousFailures.length ? `${src}!` : src, usage: { input: 0, output: 0 } };
  },
  verify(output) {
    return output.endsWith('!') ? [] : ['output must end with "!"'];
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
    step({ id: 'exclaim', uses: exclaim, params: { from: 'shout' }, retry: { attempts: 2 } }),
  ],
};

export default pipeline;
