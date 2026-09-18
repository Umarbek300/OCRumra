import { pool } from '../db/pool.js';

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

  const { rows } = await pool.query(
    `INSERT INTO groups (name, departure_date, telegram_chat_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_chat_id) DO UPDATE
       SET name = EXCLUDED.name, departure_date = EXCLUDED.departure_date
     RETURNING id, name, departure_date, telegram_chat_id`,
    [args.name, args.departureDate, args.chatId],
  );

  console.log('Registered group:', rows[0]);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
