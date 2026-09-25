import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  // Optional here so admin/migrate/health/etc. scripts never need it. The
  // OCR service (src/ocr/anthropicClient.ts) enforces its presence itself,
  // only at the point real Claude Vision processing actually starts.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5'),
  // 'anthropic' (default, unchanged behavior) | 'local' (free, on-server MRZ
  // OCR, no API key needed) | 'compare' (runs local always; only also runs
  // Anthropic if OCR_COMPARE_WITH_ANTHROPIC=true, never by default) |
  // 'google-vision' (Google Cloud Vision DOCUMENT_TEXT_DETECTION-backed MRZ
  // extraction; reads GOOGLE_APPLICATION_CREDENTIALS via the Vision SDK's
  // own Application Default Credentials lookup, never a path in this repo).
  OCR_PROVIDER: z.enum(['anthropic', 'local', 'compare', 'google-vision']).default('anthropic'),
  OCR_COMPARE_WITH_ANTHROPIC: z.coerce.boolean().default(false),
  // Optional here for the same reason as ANTHROPIC_API_KEY — admin/migrate/
  // health/test scripts never need it. Only the Sheets sync worker
  // (src/sheets/) enforces its presence, and only once it actually tries
  // to authenticate. Path to a service-account JSON key file (never the
  // key material itself in an env var — see src/sheets/sheetsAuth.ts).
  GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_FILE: z.string().min(1).optional(),
  // Drive folder a newly-created group spreadsheet is filed under. Optional:
  // when unset, a new spreadsheet is simply left wherever the service
  // account's own Drive places it.
  GOOGLE_SHEETS_DRIVE_FOLDER_ID: z.string().min(1).optional(),
  // Master switch for the Sheets sync worker (src/sheets/runSheetSyncLoop.ts).
  // Defaults to false so this feature ships dormant until explicitly turned
  // on — enqueueing into sheet_sync_queue (performPassportOcr.ts) is
  // unaffected either way; this only gates the worker that drains it.
  SHEETS_SYNC_ENABLED: z.coerce.boolean().default(false),
  // Per-request timeout (ms) applied to every Google Sheets/Drive API call
  // this pipeline makes (see src/sheets/sheetsAuth.ts's
  // getConfiguredApiTimeoutMs()). Bounds how long one stuck/slow Google API
  // call can block the sheets sync worker's current job — without this, a
  // single hung request could stall the whole poll loop indefinitely. 30s
  // is generous headroom for a normal Sheets/Drive call.
  GOOGLE_SHEETS_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}
