import { pool } from '../db/pool.js';
import { submitOperatorCommand, type SubmitOperatorCommandInput } from '../duplicates/submitOperatorCommand.js';

const USAGE = `Usage:
  npm run admin:operator-command -- --command-type cancel_passport --identity-id <uuid> --group-id <uuid> --operator-id <name> [--message-id <uuid>]
  npm run admin:operator-command -- --command-type remove_from_group --identity-id <uuid> --group-id <uuid> --operator-id <name> [--message-id <uuid>]
  npm run admin:operator-command -- --command-type move_to_group --identity-id <uuid> --from-group-id <uuid> --to-group-id <uuid> --operator-id <name> [--message-id <uuid>]`;

function parseArgs(argv: string[]): SubmitOperatorCommandInput {
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

  const commandType = flags.get('command-type');
  const identityId = flags.get('identity-id');
  const operatorId = flags.get('operator-id');
  const messageId = flags.get('message-id') ?? null;

  if (!identityId || !operatorId) {
    throw new Error(USAGE);
  }

  if (commandType === 'cancel_passport' || commandType === 'remove_from_group') {
    const groupId = flags.get('group-id');
    if (!groupId) throw new Error(USAGE);
    return { commandType, passportIdentityId: identityId, groupId, telegramMessageId: messageId, operatorId };
  }

  if (commandType === 'move_to_group') {
    const fromGroupId = flags.get('from-group-id');
    const toGroupId = flags.get('to-group-id');
    if (!fromGroupId || !toGroupId) throw new Error(USAGE);
    return { commandType, passportIdentityId: identityId, fromGroupId, toGroupId, telegramMessageId: messageId, operatorId };
  }

  throw new Error(USAGE);
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  const result = await submitOperatorCommand(input);

  if (result.outcome === 'already_pending') {
    console.log('An identical command is already pending (not inserted again):', result.command);
  } else {
    console.log('Submitted operator command:', result.command);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
