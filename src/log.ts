// The structured key=value logger used by the runner, the CLI (src/index.ts) and any client that needs a `Logger`.
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
