import { Pool, types } from 'pg';
import { env } from '../config/env.js';

// node-postgres parses the DATE type (OID 1082) into a JS Date by default,
// which silently contradicts every repo's `string` (YYYY-MM-DD) typing and
// is lossy/timezone-risky for a pure calendar date. Keep it as the raw
// 'YYYY-MM-DD' string Postgres actually sends — this is what every
// repository across the app already declares and expects.
types.setTypeParser(types.builtins.DATE, (value) => value);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});
