// The structured key=value logger used by the runner, the CLI (src/cli.ts) and any client that needs a `Logger`.
// Steps receive it through `ctx.log`.
import type { Logger } from './types.js';

export type LineWriter = (line: string) => void;
const stderrWriter: LineWriter = (line) => process.stderr.write(`${line}\n`);
/** Human-facing output (the --dry-run plan) goes to stdout, so `2>/dev/null` leaves just the plan. */
export const stdoutWriter: LineWriter = (line) => process.stdout.write(`${line}\n`);

/**
 * `<iso time> <level> <message> key=value ...`; empty values and values with whitespace, quotes or `=` are JSON-quoted.
 * The message is free text and the fields follow it, so a parser must not assume the message holds no `key=value`.
 */
export function createLogger(write: LineWriter = stderrWriter): Logger {
  const emit = (level: string, message: string, fields?: Record<string, unknown>): void => {
    const pairs = Object.entries(fields ?? {}).map(([k, v]) => `${k}=${formatValue(v)}`);
    write([new Date().toISOString(), level, message, ...pairs].join(' '));
  };
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

function formatValue(value: unknown): string {
  const text = typeof value === 'string' ? value : toText(value);
  return text === '' || /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

/** JSON, or `String(value)` for what JSON drops (undefined, functions); a BigInt, a circular value or a throwing
 * toJSON must not throw from inside the logger or the --dry-run plan. */
export function toText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unprintable]';
  }
}

/** The same policy over more than one line, for a rendered document: a string as it is, anything else as indented
 * JSON, `String(value)` for what JSON drops and `[unprintable]` for what it cannot render. The review file
 * (src/review.ts) and a step's prompt (src/steps/shared.ts, as `asText`) both render a value this way. */
export function prettyText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[unprintable]';
  }
}

/** The message of an Error, or the String of anything else thrown. */
export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
