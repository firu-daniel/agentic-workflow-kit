// The step library a pipeline file imports from: `import { fetchPages, extract, plan, draft, emit, minLength, … } from
// '../src/steps/index.js'`. Each step is one bounded call (an HTTP GET, one LLM completion, one file write) with a
// JSON-serializable output and a deterministic verify; the rule factories attach further checks in the pipeline.
export { fetchPages, fetchPagesWith, htmlToText, type FetchPagesParams, type FetchedPage } from './fetchPages.js';
export { extract, parseJson, type ExtractParams } from './extract.js';
export { plan, hasHeading, type PlanParams } from './plan.js';
export { draft, type DraftParams } from './draft.js';
export { emit, emitWith, type EmitParams, type EmitOutput } from './emit.js';
export { minLength, maxLength, requiredSections, noFabricatedUrls, noFabricatedEmails, matchesSchema } from './verify.js';
export { validate, example, type Schema } from './schema.js';
export { urlsIn, emailsIn, type From } from './shared.js';
