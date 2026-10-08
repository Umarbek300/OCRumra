import { pool } from '../db/pool.js';
import { splitLink } from '../duplicates/splitLink.js';

const USAGE = `Usage:
  npm run admin:split-link -- --link-id <uuid> --operator-id <name>`;

export interface SplitLinkCliInput {
  linkId: string;
  operatorId: string;
}

export function parseArgs(argv: string[]): SplitLinkCliInput {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      flags.set(arg.slice(2), value);
      i += 1;
    }
  }

  const linkId = flags.get('link-id');
  const operatorId = flags.get('operator-id');
  if (!linkId || !operatorId) {
    throw new Error(USAGE);
  }
  return { linkId, operatorId };
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  const result = await splitLink(input.linkId, input.operatorId);
  console.log('Split result:', result);
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
