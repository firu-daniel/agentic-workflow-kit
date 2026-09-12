// Helpers the LLM-backed steps (extract, plan, draft) share: reading the inputs a step names, rendering them into a
// prompt, turning the previous attempt's failures into a correction paragraph so a retry fixes the answer instead
// of repeating it, and refusing an answer the output cap cut short.
import { NonRetryableError } from '../types.js';
import type { StepContext } from '../types.js';

/** A step id, or a list of them, whose outputs a step reads. */
export type From = string | string[];

export const fromIds = (from: From): string[] => (Array.isArray(from) ? from : [from]);

/** The named inputs, in order; a missing one (a typo, or a step listed later in the pipeline) cannot be fixed by a
 * retry, so it is a NonRetryableError naming the id. */
export function readInputs(ctx: StepContext, from: From): { id: string; value: unknown }[] {
  return fromIds(from).map((id) => {
    if (!(id in ctx.inputs)) {
      throw new NonRetryableError(`step "${ctx.stepId}": input "${id}" is not the output of an earlier step`);
    }
    return { id, value: ctx.inputs[id] };
  });
}

/** Per-input character cap when rendering inputs into a prompt; keeps a fetched site from blowing the context. */
export const DEFAULT_INPUT_CHARS = 60_000;

/** One text block per input: a string as it is, anything else as pretty JSON, each cut at `maxChars` with a marker. */
export function renderInputs(inputs: { id: string; value: unknown }[], maxChars = DEFAULT_INPUT_CHARS): string {
  return inputs.map(({ id, value }) => `### input "${id}"\n${clip(asText(value), maxChars)}`).join('\n\n');
}

export const asText = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value));

export const clip = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[… cut at ${maxChars} characters]`;

/** Empty on a first attempt; on a retry, the previous failures as a numbered list the model is told to fix. */
export function correctionBlock(ctx: StepContext): string {
  if (!ctx.previousFailures.length) return '';
  const list = ctx.previousFailures.map((f, i) => `${i + 1}. ${f}`).join('\n');
  return `\n\nYour previous answer was rejected for these reasons; produce a corrected answer that fixes every one:\n${list}`;
}

/** URLs in a text, trailing punctuation, markdown emphasis and closing brackets stripped, in order of first
 * appearance, unique. `**https://a.io/x**` is the URL, not a fabricated one. */
export function urlsIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []) {
    seen.add(match.replace(/[.,;:!?*_]+$/, ''));
  }
  return [...seen];
}

/** A response cut at the output cap. A retry at the same cap is cut the same way (src/types.ts), and a half-written
 * answer must not reach verify as if it were whole, so the run stops here. */
export const cutShort = (ctx: StepContext, maxTokens: number | undefined): NonRetryableError =>
  new NonRetryableError(
    `step "${ctx.stepId}": the answer was cut short at maxTokens=${maxTokens ?? 'the client default'}`
    + '; a retry at the same cap would be cut too — raise it or ask for less',
  );
