// `draft`: one LLM call that writes the piece in markdown from the named inputs (sources, an extract's data, a plan).
// Its own `verify` covers the shape (non-empty, the required sections); the content rules — length, no URL that is
// not in the sources — are the rule factories in ./verify.ts, attached in the pipeline so the retry corrects the draft
// with the exact failures. An answer the output cap cut short stops the run: a piece ending mid-sentence must not be
// emitted as the deliverable. The mock answers with the requested sections and quotes source URLs when the named
// inputs carry any, so `noFabricatedUrls` is exercised offline wherever they do — in the demo pipeline the offline
// inputs (a mock extract and a mock outline) carry none.
import { hasHeading } from './plan.js';
import { asText, correctionBlock, cutShort, readInputs, renderInputs, urlsIn, type From } from './shared.js';
import type { Step } from '../types.js';

export interface DraftParams {
  from: From;
  /** What to write, for whom, in what tone; the sections and the rules are appended. */
  instruction: string;
  /** Section headings the draft must have, in order; free when unset. */
  sections?: string[];
  maxInputChars?: number;
  maxTokens?: number;
}

export const DRAFT_SYSTEM_PROMPT =
  'You write publication-ready markdown from the sources you are given. Answer with the piece only, no preamble, '
  + 'no commentary. Cite only URLs that appear in the sources; invent none. Use no contact details (email address, '
  + 'phone number, social handle) that do not appear in the sources.';

export const draft: Step<DraftParams, string> = {
  name: 'draft',
  async run(ctx) {
    const { instruction, sections, maxInputChars, maxTokens } = ctx.params;
    const inputs = readInputs(ctx, ctx.params.from);
    const structure = sections?.length ? `Use exactly these "## " sections, in this order: ${sections.map((s) => `"${s}"`).join(', ')}.\n\n` : '';
    const prompt = `${instruction}\n\n${structure}Sources:\n\n${renderInputs(inputs, maxInputChars)}${correctionBlock(ctx)}`;
    const res = await ctx.llm.complete({ system: DRAFT_SYSTEM_PROMPT, prompt, maxTokens, mockReply: mockDraft(sections, inputs) });
    if (res.truncated) throw cutShort(ctx, maxTokens);
    return { output: res.text.trim(), usage: res.usage };
  },
  verify(output, ctx) {
    const failures: string[] = [];
    if (!output) failures.push('empty draft');
    for (const s of ctx.params.sections ?? []) if (!hasHeading(output, s)) failures.push(`missing section "## ${s}"`);
    return failures;
  },
};

/** ~600 characters of filler per section, so a `minLength` rule of a few hundred characters per section passes. */
function mockDraft(sections: string[] | undefined, inputs: { id: string; value: unknown }[]): string {
  const links = inputs.flatMap(({ value }) => urlsIn(asText(value))).slice(0, 3);
  const filler = 'This paragraph stands in for model output: the offline mock wrote it, no model was called, and it carries '
    + 'no facts from the sources. A real run replaces it with prose drawn from the inputs named in the pipeline. ';
  const body = (sections?.length ? sections : ['Summary']).map((s) => `## ${s}\n\n${filler.repeat(3).trim()}`);
  if (links.length) body.push(`Sources: ${links.join(' ')}`);
  return body.join('\n\n');
}
