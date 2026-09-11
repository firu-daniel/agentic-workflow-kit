// Entry point. Usage: npm run start -- --pipeline <name> [--dry-run] [--approve]
// The runner core (src/runner.ts), LLM client (src/llm.ts) and step library
// (src/steps/) land in the next commits; this stub only parses the flags.

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1] ?? 'true';
};

const pipeline = flag('pipeline');
if (!pipeline) {
  console.log('Usage: npm run start -- --pipeline <name> [--dry-run] [--approve]');
  console.log('Pipelines live in pipelines/<name>.ts');
  process.exit(0);
}

console.log(`pipeline=${pipeline} dryRun=${flag('dry-run') === 'true'} approve=${flag('approve') === 'true'}`);
