// Example pipeline: the latest releases of a GitHub repository → structured facts → an outline → a changelog post
// → out/changelog.md (and a PR when GITHUB_TOKEN is set). Five library steps, one file. Runs green offline:
// `AWK_OFFLINE=1 AWK_LLM=mock npm run start -- --pipeline example-changelog` uses the committed fixture and the mock;
// without those variables it fetches the GitHub API and calls whichever LLM mode the environment selects.
import { step, type Pipeline } from '../src/types.js';
import { draft, emit, extract, fetchPages, minLength, noFabricatedUrls, plan, type Schema } from '../src/steps/index.js';

const RELEASES_URL = 'https://api.github.com/repos/nodejs/node/releases?per_page=3';
const SECTIONS = ['Summary', 'Highlights', 'Links'];

const releasesSchema: Schema = {
  type: 'object',
  properties: {
    releases: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string', minLength: 1 },
          date: { type: 'string', description: 'ISO date' },
          url: { type: 'string', description: 'the release page URL exactly as it appears in the source' },
          highlights: { type: 'array', items: { type: 'string' }, description: 'the notable changes, one per item' },
        },
        required: ['tag', 'url', 'highlights'],
      },
    },
  },
  required: ['releases'],
};

const pipeline: Pipeline = {
  name: 'example-changelog',
  steps: [
    step({
      id: 'releases',
      uses: fetchPages,
      params: {
        urls: [RELEASES_URL],
        fixtures: { [RELEASES_URL]: 'pipelines/fixtures/nodejs-releases.json' },
        headers: { accept: 'application/vnd.github+json' },
      },
    }),
    step({
      id: 'facts',
      uses: extract,
      params: {
        from: 'releases',
        instruction: 'List every release in the source with its tag, publication date, release page URL and the notable changes from its notes.',
        schema: releasesSchema,
      },
    }),
    step({
      id: 'outline',
      uses: plan,
      params: { from: 'facts', goal: 'A short changelog post for developers who follow Node.js releases.', sections: SECTIONS },
    }),
    step({
      id: 'post',
      uses: draft,
      params: {
        from: ['facts', 'outline'],
        instruction: 'Write the changelog post the outline describes: plain, specific, for developers. Under "Links", list each release page URL from the facts.',
        sections: SECTIONS,
      },
      // The fetched page only: `extract` is told to copy each URL verbatim, so its output cannot widen the corpus.
      verify: [minLength(600), noFabricatedUrls(['releases'])],
    }),
    step({
      id: 'publish',
      uses: emit,
      params: { from: 'post', path: 'changelog.md', title: 'Node.js releases' },
      gate: true,
    }),
  ],
};

export default pipeline;
