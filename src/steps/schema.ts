// A small JSON-schema subset for `extract`: enough to describe the structured output a step asks the model for,
// validate the answer deterministically (failures are the correction the retry gets) and build an example value that
// satisfies the schema — what the offline mock returns, so a pipeline runs green with no model. No dependency.
import { errorText } from '../log.js';
import { NonRetryableError } from '../types.js';

export type Schema =
  | { type: 'object'; properties: Record<string, Schema>; required?: string[]; description?: string }
  | { type: 'array'; items: Schema; minItems?: number; maxItems?: number; description?: string }
  | { type: 'string'; enum?: string[]; minLength?: number; pattern?: string; description?: string }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number; description?: string }
  | { type: 'boolean'; description?: string };

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Compiled once per pattern string, since `validate` runs it per value. A pattern that does not compile is the
 * pipeline's own mistake: no retry can fix it, so it leaves `validate` / `example` as a NonRetryableError. */
const compiled = new Map<string, RegExp>();

function patternOf(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    throw new NonRetryableError(`schema: pattern /${pattern}/ does not compile: ${errorText(err)}`, { cause: err });
  }
  compiled.set(pattern, re);
  return re;
}

/** Every violation as `<json path>: <what was expected>`; an empty list means the value matches. Unknown properties
 * pass (the model may add context), a missing required one or a wrong type fails. */
export function validate(schema: Schema, value: unknown, at = '$'): string[] {
  const failures: string[] = [];
  switch (schema.type) {
    case 'object': {
      if (typeOf(value) !== 'object') return [`${at}: expected an object, got ${typeOf(value)}`];
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!(key in obj)) failures.push(`${at}.${key}: required property is missing`);
      for (const [key, sub] of Object.entries(schema.properties)) if (key in obj) failures.push(...validate(sub, obj[key], `${at}.${key}`));
      return failures;
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${at}: expected an array, got ${typeOf(value)}`];
      if (schema.minItems !== undefined && value.length < schema.minItems) failures.push(`${at}: expected at least ${schema.minItems} items, got ${value.length}`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) failures.push(`${at}: expected at most ${schema.maxItems} items, got ${value.length}`);
      value.forEach((item, i) => failures.push(...validate(schema.items, item, `${at}[${i}]`)));
      return failures;
    }
    case 'string': {
      if (typeof value !== 'string') return [`${at}: expected a string, got ${typeOf(value)}`];
      if (schema.enum && !schema.enum.includes(value)) failures.push(`${at}: expected one of ${schema.enum.join(', ')}, got "${value}"`);
      if (schema.minLength !== undefined && value.length < schema.minLength) failures.push(`${at}: expected at least ${schema.minLength} characters`);
      if (schema.pattern !== undefined && !patternOf(schema.pattern).test(value)) failures.push(`${at}: expected to match /${schema.pattern}/`);
      return failures;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${at}: expected ${schema.type === 'integer' ? 'an integer' : 'a number'}, got ${typeOf(value)}`];
      if (schema.type === 'integer' && !Number.isInteger(value)) failures.push(`${at}: expected an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) failures.push(`${at}: expected at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) failures.push(`${at}: expected at most ${schema.maximum}`);
      return failures;
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at}: expected a boolean, got ${typeOf(value)}`];
  }
}

/** A value that `validate` accepts: every property present (required or not), a length inside `[minItems, maxItems]`,
 * the first enum member that fits, `minLength` `x`s, the minimum (rounded up for an integer) or 0; strings say which
 * property they stand in for. A schema no generated value can satisfy — a `pattern` outside an enum (not synthesized),
 * an empty or impossible range — throws NonRetryableError: the mock cannot answer it, and no retry would change that. */
export function example(schema: Schema, name = 'value'): unknown {
  switch (schema.type) {
    case 'object':
      return Object.fromEntries(Object.entries(schema.properties).map(([key, sub]) => [key, example(sub, key)]));
    case 'array': {
      const length = Math.min(Math.max(1, schema.minItems ?? 1), schema.maxItems ?? Infinity);
      if (schema.minItems !== undefined && length < schema.minItems) throw noExample(name, `minItems ${schema.minItems} is above maxItems ${schema.maxItems}`);
      return Array.from({ length }, (_, i) => example(schema.items, `${name} ${i + 1}`));
    }
    case 'string': {
      const fits = (s: string): boolean =>
        (schema.minLength === undefined || s.length >= schema.minLength)
        && (schema.pattern === undefined || patternOf(schema.pattern).test(s));
      if (schema.enum?.length) {
        const member = schema.enum.find(fits);
        if (member === undefined) throw noExample(name, 'no enum member satisfies its minLength / pattern');
        return member;
      }
      if (schema.pattern !== undefined) throw noExample(name, `a pattern (/${schema.pattern}/) is not synthesized; give the property an enum`);
      const text = `example ${name}`;
      return schema.minLength !== undefined && text.length < schema.minLength ? text.padEnd(schema.minLength, 'x') : text;
    }
    case 'number':
    case 'integer': {
      const low = schema.minimum ?? -Infinity;
      const high = schema.maximum ?? Infinity;
      // 0 when the range allows it, else the nearer bound, moved onto a whole number for an integer.
      let value = Math.min(Math.max(0, low), high);
      if (schema.type === 'integer') value = value > 0 ? Math.ceil(value) : Math.floor(value);
      if (value < low || value > high) throw noExample(name, `no ${schema.type} lies between minimum ${schema.minimum} and maximum ${schema.maximum}`);
      return value;
    }
    case 'boolean':
      return true;
  }
}

const noExample = (name: string, why: string): NonRetryableError =>
  new NonRetryableError(`schema: "${name}" has no generated example: ${why}`);
