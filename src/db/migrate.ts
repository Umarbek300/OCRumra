import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(rows.map((row) => row.name));
}

async function getMigrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((file) => file.endsWith('.sql')).sort();
}

async function runMigration(file: string): Promise<void> {
  const filePath = path.join(MIGRATIONS_DIR, file);
  const sql = await readFile(filePath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`Applied migration: ${file}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`Migration failed: ${file}\n${(error as Error).message}`);
  } finally {
    client.release();
  }
}

export async function migrateUp(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const files = await getMigrationFiles();
  const pending = files.filter((file) => !applied.has(file));

  if (pending.length === 0) {
    console.log('No pending migrations.');
    return;
  }

  for (const file of pending) {
    await runMigration(file);
  }
}

export async function migrationStatus(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const files = await getMigrationFiles();

  for (const file of files) {
    console.log(`${applied.has(file) ? '[applied]' : '[pending]'} ${file}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  if (command === 'up') {
    await migrateUp();
  } else if (command === 'status') {
    await migrationStatus();
  } else {
    throw new Error(`Unknown migrate command: ${command}`);
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
