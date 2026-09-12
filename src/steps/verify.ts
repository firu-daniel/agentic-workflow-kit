// Deterministic verify rules, attached to the step whose output they check (`verify: [...]` in the pipeline) so a
// failure retries that step with the exact failure text — code decides before any model judges. Each factory returns a
// `VerifyRule`; `noFabricatedUrls` and `matchesSchema` read other steps' outputs through the context.
import { validate, type Schema } from './schema.js';
import { hasHeading } from './plan.js';
import { asText, readInputs, urlsIn, type From } from './shared.js';
import type { VerifyRule } from '../types.js';

const textOf = (output: unknown): string => asText(output);

/** The output (a string, else its JSON) is at least `chars` long. */
export const minLength = (chars: number): VerifyRule => (output) => {
  const n = textOf(output).length;
  return n >= chars ? [] : [`too short: ${n} characters, at least ${chars} required`];
};

/** The output is at most `chars` long. */
export const maxLength = (chars: number): VerifyRule => (output) => {
  const n = textOf(output).length;
  return n <= chars ? [] : [`too long: ${n} characters, at most ${chars} allowed`];
};

/** A markdown output has a heading for every title (any level, case-insensitive). */
export const requiredSections = (titles: string[]): VerifyRule => (output) => {
  const text = textOf(output);
  return titles.flatMap((t) => (hasHeading(text, t) ? [] : [`missing section "${t}"`]));
};

/** Every URL in the output appears in the outputs of the steps named (fetched pages, an extract's data): a URL the
 * model made up is a failure naming it. `allow` adds URLs that are fine to cite without a source (the site's own).
 * A named step that is not an earlier one would leave the corpus empty and fail every URL, so it is a
 * NonRetryableError naming the id (`readInputs`), as it is in the steps. */
export const noFabricatedUrls = (from: From, allow: string[] = []): VerifyRule => (output, ctx) => {
  const corpus = readInputs(ctx, from).map(({ value }) => textOf(value)).join('\n');
  const known = new Set([...urlsIn(corpus), ...allow].map(normalize));
  return urlsIn(textOf(output)).flatMap((url) => (known.has(normalize(url)) ? [] : [`URL not in the sources: ${url}`]));
};

/** The output validates against the schema (the `extract` step applies its own schema; this is for any other step). */
export const matchesSchema = (schema: Schema): VerifyRule => (output) => validate(schema, output);

/** A trailing slash, and nothing else, is ignored when comparing URLs. */
const normalize = (url: string): string => url.replace(/\/+$/, '');
