// Entry point: `npm run start -- --pipeline <name> [--dry-run] [--approve] [--fresh]`. The command itself is
// src/cli.ts (flag parsing, pipeline loading, exit codes); this file only binds it to the process.
import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2));
