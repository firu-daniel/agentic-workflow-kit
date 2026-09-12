// `plan`: one LLM call that writes a markdown outline for a goal from the named inputs — the sections the draft will
// have and, under each, the points to make with the source they come from. A cheap step whose output a `draft` step
// reads, so the expensive call works from an agreed structure. An answer the output cap cut short stops the run, as
// in the other LLM steps. The mock answers with the requested sections.
import { correctionBlock, cutShort, readInputs, renderInputs, type From } from './shared.js';
import type { Step } from '../types.js';

export interface PlanParams {
  from: From;
  /** What the final piece is for, in plain words. */
  goal: string;
  /** Section headings the plan must use, in order; free when unset. */
  sections?: string[];
  maxInputChars?: number;
  maxTokens?: number;
}

export const PLAN_SYSTEM_PROMPT =
  'You plan written pieces. Answer with a markdown outline only: one "## " heading per section, bullet points under each '
  + 'naming the point to make and the source it comes from. No preamble, no draft prose.';

export const plan: Step<PlanParams, string> = {
  name: 'plan',
  async run(ctx) {
    const { goal, sections, maxInputChars, maxTokens } = ctx.params;
    const inputs = readInputs(ctx, ctx.params.from);
    const structure = sections?.length ? `Use exactly these sections, in this order: ${sections.map((s) => `"${s}"`).join(', ')}.\n\n` : '';
    const prompt = `Goal: ${goal}\n\n${structure}Sources:\n\n${renderInputs(inputs, maxInputChars)}${correctionBlock(ctx)}`;
    const mockReply = (sections?.length ? sections : ['Summary', 'Details'])
      .map((s) => `## ${s}\n- [mock] point for ${s}, from input "${inputs[0]?.id}"`).join('\n\n');
    const res = await ctx.llm.complete({ system: PLAN_SYSTEM_PROMPT, prompt, maxTokens, mockReply });
    if (res.truncated) throw cutShort(ctx, maxTokens);
    return { output: res.text.trim(), usage: res.usage };
  },
  verify(output, ctx) {
    const failures: string[] = [];
    if (!output) failures.push('empty plan');
    for (const s of ctx.params.sections ?? []) if (!hasHeading(output, s)) failures.push(`missing section "## ${s}"`);
    return failures;
  },
};

/** A markdown heading line of any level whose text is `title` (case-insensitive, surrounding whitespace ignored). */
export function hasHeading(markdown: string, title: string): boolean {
  const want = title.trim().toLowerCase();
  return markdown.split('\n').some((line) => {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    return m !== null && m[1].trim().toLowerCase() === want;
  });
}
