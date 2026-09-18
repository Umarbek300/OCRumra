import { pool } from '../db/pool.js';

interface Args {
  name: string;
  telegramUserId: number;
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
  const userIdRaw = flags.get('user-id');

  if (!name || !userIdRaw) {
    throw new Error('Usage: npm run admin:register-agent -- --name "Jane Agent" --user-id 123456789');
  }

  const telegramUserId = Number(userIdRaw);
  if (!Number.isInteger(telegramUserId)) {
    throw new Error(`--user-id must be an integer, got: ${userIdRaw}`);
  }

  return { name, telegramUserId };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const { rows } = await pool.query(
    `INSERT INTO agents (name, telegram_user_id)
     VALUES ($1, $2)
     ON CONFLICT (telegram_user_id) DO UPDATE
       SET name = EXCLUDED.name
     RETURNING id, name, telegram_user_id, is_active`,
    [args.name, args.telegramUserId],
  );

  console.log('Registered agent:', rows[0]);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
