// `extract`: one LLM call that turns the named inputs into structured data matching a schema. The answer is parsed as
// JSON (a ```json fence is tolerated) and validated by `verify`; every violation is a failure string, so the retry
// asks again with the exact violations to fix. An answer the output cap cut short stops the run instead: the JSON is
// half-written and the same cap would cut the retry too. The offline mock answers with `example(schema)`, which
// validates; a schema `example` cannot build (a `pattern` outside an enum) gets the mock's canned text and a warning.
import { example, validate, type Schema } from './schema.js';
import { correctionBlock, cutShort, readInputs, renderInputs, type From } from './shared.js';
import { errorText } from '../log.js';
import type { Step, StepContext } from '../types.js';

export interface ExtractParams {
  from: From;
  /** What to extract, in plain words; the schema is appended to it. */
  instruction: string;
  schema: Schema;
  /** Per-input character cap when rendering the inputs into the prompt (default DEFAULT_INPUT_CHARS in shared.ts). */
  maxInputChars?: number;
  maxTokens?: number;
}

export const EXTRACT_SYSTEM_PROMPT =
  'You extract structured data from the sources you are given. Answer with one JSON value only, no prose, no code fence. '
  + 'Use only facts present in the sources. Leave a property out only when the schema does not require it; when a '
  + 'required property has no supporting fact, give the empty value its type allows — "" for a string, [] for an '
  + 'array, 0 for a number — so the answer still matches the schema. Use no contact details (email address, phone '
  + 'number, social handle) that do not appear in the sources.';

export const extract: Step<ExtractParams, unknown> = {
  name: 'extract',
  async run(ctx) {
    const { instruction, schema, maxInputChars, maxTokens } = ctx.params;
    const inputs = readInputs(ctx, ctx.params.from);
    const prompt = `${instruction}\n\nThe JSON must match this schema:\n${JSON.stringify(schema, null, 2)}\n\n`
      + `Sources:\n\n${renderInputs(inputs, maxInputChars)}${correctionBlock(ctx)}`;
    const res = await ctx.llm.complete({ system: EXTRACT_SYSTEM_PROMPT, prompt, maxTokens, mockReply: mockReplyFor(schema, ctx) });
    if (res.truncated) throw cutShort(ctx, maxTokens);
    return { output: parseJson(res.text), usage: res.usage };
  },
  verify(output, ctx) {
    if (output instanceof NotJson) return [`the answer is not JSON: ${output.message}`];
    return validate(ctx.params.schema, output);
  },
};

/** The mock's answer: `example(schema)`. A schema `example` cannot build (a `pattern` outside an enum) only matters
 * offline, so it is a warning here and the mock's canned text — which fails verify legibly — not a failure of a real run. */
function mockReplyFor(schema: Schema, ctx: StepContext<ExtractParams>): string | undefined {
  try {
    return JSON.stringify(example(schema), null, 2);
  } catch (err) {
    ctx.log.warn('extract: no mock reply for this schema', { step: ctx.stepId, reason: errorText(err) });
    return undefined;
  }
}

/** Stands in for the output when the answer is not JSON, so `verify` reports that in words rather than a type error.
 * Never reaches the checkpoint: a failed verify keeps the output out of it. */
class NotJson extends Error {}

/** The answer as JSON: the whole text, else the first ```json fence, else the outermost `{…}` / `[…]` span. */
export function parseJson(text: string): unknown {
  const candidates = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  if (fence) candidates.push(fence.trim());
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  let lastError = 'empty answer';
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return new NotJson(lastError);
}
