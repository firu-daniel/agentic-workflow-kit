// prommer.net → proof points → a counterparty brief for founders/operators + three post drafts → out/.
// Five library steps, one file. The first emit is gated: a human reads the brief before the posts are written out.
// Run:  AWK_LLM=claude-code npm run start -- --pipeline pipelines/prommer-net.ts   (exit 3 at the gate; --approve to finish)
import { step, type Pipeline } from '../src/types.js';
import { draft, emit, extract, fetchPages, minLength, maxLength, noFabricatedEmails, noFabricatedUrls, requiredSections, type Schema } from '../src/steps/index.js';

const PRESS = 'https://prommer.net/en/tech/press/';
const PROFILE = 'https://prommer.net/en/tech/profile/';

// Typed input: the audiences the card names. One post per audience.
const AUDIENCES = [
  { name: 'Founders evaluating a counterparty', angle: 'what it is like to work with him; decisions, numbers, what broke' },
  { name: 'Operators running AI-native teams', angle: 'one concrete operating practice they can copy this week' },
  { name: 'Press and podcast bookers', angle: 'one claim with a dated, citable source and a clear ask' },
];
const POST_SECTIONS = AUDIENCES.map((a) => a.name);
const BRIEF_SECTIONS = ['Who', 'Evidence', 'What he is asked about', 'Sources'];

const proofSchema: Schema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    positioning: { type: 'string', description: 'one sentence, in the site\'s own words' },
    proof: {
      type: 'array',
      minItems: 3,
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', minLength: 1, description: 'one specific, checkable claim' },
          outlet: { type: 'string', description: 'publication or venue, or "prommer.net" for a first-party fact' },
          date: { type: 'string', description: 'as written in the source, or ""' },
          url: { type: 'string', description: 'a URL exactly as it appears in the sources' },
        },
        required: ['claim', 'outlet', 'url'],
      },
    },
    topics: { type: 'array', minItems: 1, items: { type: 'string' } },
  },
  required: ['name', 'positioning', 'proof', 'topics'],
};

const pipeline: Pipeline = {
  name: 'prommer-net',
  steps: [
    step({
      id: 'pages',
      uses: fetchPages,
      params: { urls: [PRESS, PROFILE], maxChars: 15000 },
    }),
    step({
      id: 'proof',
      uses: extract,
      params: {
        from: 'pages',
        instruction:
          'From the site text, extract the person, their positioning, the topics they are quoted on, and the proof points '
          + 'a founder or booker could verify: press quotes with outlet and date, roles with dates, first-party numbers. '
          + 'Copy every URL verbatim from the sources. Do not invent an outlet, a date or a URL.',
        schema: proofSchema,
      },
    }),
    step({
      id: 'brief',
      uses: draft,
      params: {
        from: 'proof',
        instruction:
          'Write a one-page brief for a founder deciding whether to work with this person. Plain and specific; no adjective '
          + 'a fact could replace. Under "Evidence", each item is one claim with its outlet and date. Under "Sources", list '
          + 'only URLs present in the proof. No email addresses.',
        sections: BRIEF_SECTIONS,
      },
      verify: [minLength(500), maxLength(6000), noFabricatedUrls(['pages']), noFabricatedEmails(['pages'])],
    }),
    step({
      id: 'posts',
      uses: draft,
      params: {
        from: ['proof', 'brief'],
        instruction:
          'Write one short post per audience, each under its own "## <audience>" heading, in this order: '
          + AUDIENCES.map((a) => `${a.name} (${a.angle})`).join('; ')
          + '. Each post: at most 150 words, one proof point with its outlet, first person, no hype words, ends with one '
          + 'concrete next step. No URL that is not in the proof. No email addresses.',
        sections: POST_SECTIONS,
      },
      verify: [minLength(400), requiredSections(POST_SECTIONS), noFabricatedUrls(['pages']), noFabricatedEmails(['pages'])],
    }),
    step({
      id: 'publish-brief',
      uses: emit,
      params: { from: 'brief', path: 'prommer-brief.md', title: 'Counterparty brief: Thomas Prommer' },
      gate: true,
    }),
    step({
      id: 'publish-posts',
      uses: emit,
      params: { from: 'posts', path: 'prommer-posts.md', title: 'Posts: Thomas Prommer' },
    }),
  ],
};

export default pipeline;
