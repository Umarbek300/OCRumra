import { pool } from '../db/pool.js';
import { mergeIdentities } from '../duplicates/mergeIdentities.js';

const USAGE = `Usage:
  npm run admin:merge-identities -- --identity-a <uuid> --identity-b <uuid> --operator-id <name>`;

export interface MergeIdentitiesCliInput {
  identityAId: string;
  identityBId: string;
  operatorId: string;
}

export function parseArgs(argv: string[]): MergeIdentitiesCliInput {
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

  const identityAId = flags.get('identity-a');
  const identityBId = flags.get('identity-b');
  const operatorId = flags.get('operator-id');
  if (!identityAId || !identityBId || !operatorId) {
    throw new Error(USAGE);
  }
  if (identityAId === identityBId) {
    throw new Error('admin:merge-identities: --identity-a and --identity-b must differ');
  }
  return { identityAId, identityBId, operatorId };
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  const result = await mergeIdentities(input.identityAId, input.identityBId, input.operatorId);
  console.log('Merge result:', result);
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
