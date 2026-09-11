// Compile-time test for src/types.ts: `npm run typecheck` fails if any @ts-expect-error line stops erroring
// (the `step()` helper lost its inference) or if the positive cases stop type-checking. Never executed.
import { step, type Pipeline, type Step } from '../src/types.js';

const constant: Step<{ value: string }, string> = {
  name: 'constant',
  async run(ctx) {
    return { output: ctx.params.value };
  },
};

// Positive: typed helper form and plain object form both satisfy Pipeline.
export const typed: Pipeline = {
  name: 'typed',
  steps: [
    step({
      id: 'seed',
      uses: constant,
      params: { value: 'hello' },
      verify: [(o) => (o.length > 0 ? [] : ['empty'])],
      retry: { attempts: 2 },
      gate: true,
    }),
  ],
};

export const plain: Pipeline = {
  name: 'plain',
  steps: [{ id: 'seed', uses: constant, params: { value: 'hi' } }],
};

// Negative: the helper rejects a wrong param type and a verify rule on the wrong output type.
// @ts-expect-error value must be a string
step({ id: 'bad-param', uses: constant, params: { value: 1 } });
// @ts-expect-error verify rule receives a string, not a number
step({ id: 'bad-rule', uses: constant, params: { value: 'x' }, verify: [(o: number) => []] });
