// CLI test fixture: one step that calls the LLM slot, so the command is exercised end to end in both modes — the mock
// (no ANTHROPIC_API_KEY) and the Anthropic client against a local stand-in server (ANTHROPIC_BASE_URL). The step
// reports the call's usage so the step line shows real in=/out= counts.
import { step, type Pipeline, type Step } from '../../src/types.js';

const ask: Step<{ question: string }, string> = {
  name: 'ask',
  async run(ctx) {
    const res = await ctx.llm.complete({
      system: 'Answer in one word.',
      prompt: ctx.params.question,
      maxTokens: 64,
      mockReply: 'FORTY-TWO',
    });
    return { output: res.text, usage: res.usage };
  },
  verify(output) {
    return output.trim() ? [] : ['empty answer'];
  },
};

const pipeline: Pipeline = {
  name: 'cli-ask',
  steps: [step({ id: 'ask', uses: ask, params: { question: 'What is six times seven?' } })],
};

export default pipeline;
