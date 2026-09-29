import { pool } from '../db/pool.js';
import { backfillUnlinkedMessagesForGroup } from '../telegram/ensureGroupRegistered.js';

interface Args {
  name: string;
  departureDate: string;
  chatId: number;
}

function parseArgs(argv: string[]): Args {
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

  const name = flags.get('name');
  const departureDate = flags.get('departure-date');
  const chatIdRaw = flags.get('chat-id');

  if (!name || !departureDate || !chatIdRaw) {
    throw new Error(
      'Usage: npm run admin:register-group -- --name "20 September 2026" --departure-date 2026-09-20 --chat-id -1001234567890',
    );
  }

  const chatId = Number(chatIdRaw);
  if (!Number.isInteger(chatId)) {
    throw new Error(`--chat-id must be an integer, got: ${chatIdRaw}`);
  }

  return { name, departureDate, chatId };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const { rows } = await pool.query<{ id: string; name: string; departure_date: string; telegram_chat_id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_chat_id) DO UPDATE
       SET name = EXCLUDED.name, departure_date = EXCLUDED.departure_date
     RETURNING id, name, departure_date, telegram_chat_id`,
    [args.name, args.departureDate, args.chatId],
  );

  const group = rows[0];
  console.log('Registered group:', group);

  // Also sweeps any messages that arrived for this chat BEFORE it was
  // registered (group_id IS NULL) -- links them, creates their
  // passport_processing record, and enqueues them, exactly as the bot's
  // own automatic registration path does (see ensureGroupRegistered.ts).
  // Idempotent: re-running this command finds nothing left to backfill.
  if (group) {
    const backfilledMessageCount = await backfillUnlinkedMessagesForGroup(args.chatId, group.id);
    if (backfilledMessageCount > 0) {
      console.log(`Backfilled ${backfilledMessageCount} previously-unlinked message(s) for this chat.`);
    }
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
