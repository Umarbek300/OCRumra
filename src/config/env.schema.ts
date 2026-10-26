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
  //
  // Deliberately NOT z.coerce.boolean(): that coerces via JS's native
  // Boolean(...), so the literal string "false" (non-empty) parses as
  // `true` — silently defeating the one env var this flag exists to gate
  // on. This instead only accepts the exact strings "true"/"false" (or the
  // var being unset, defaulting to false); anything else is a validation
  // error at startup rather than a silently-wrong boolean.
  SHEETS_SYNC_ENABLED: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return false;
      if (value === 'true') return true;
      if (value === 'false') return false;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SHEETS_SYNC_ENABLED must be "true" or "false" if set' });
      return z.NEVER;
    }),
  // Master switch for the VisitSaudi stale-record recovery loop
  // (src/visa/runVisaRecoveryLoop.ts, started via src/visa/start.ts /
  // `npm run visa:worker`). Defaults to false so this feature ships
  // dormant until explicitly turned on -- Package 5.17 deliberately makes
  // no production-enablement decision itself. Unlike SHEETS_SYNC_ENABLED
  // (which the sync loop itself polls every cycle, so it can be toggled
  // without a restart), this flag is only read ONCE at worker startup
  // (src/visa/start.ts): recovery never submits, claims, or finalizes
  // anything, and never invokes portal automation, so there is no
  // "mid-run" state that needs live toggling -- when disabled, the worker
  // exits cleanly before the recovery loop (or either store) is ever
  // constructed.
  //
  // Same z.coerce.boolean() pitfall and fix as SHEETS_SYNC_ENABLED above:
  // only the exact strings "true"/"false" (or unset, defaulting to false)
  // are accepted; anything else is a validation error at startup.
  VISA_RECOVERY_ENABLED: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return false;
      if (value === 'true') return true;
      if (value === 'false') return false;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'VISA_RECOVERY_ENABLED must be "true" or "false" if set' });
      return z.NEVER;
    }),
  // Phase 2e / B-bosqich (Package 5.45): the loopback HTTP endpoint
  // (e.g. "http://127.0.0.1:9222") this process connects to, as a Chrome
  // DevTools Protocol CLIENT, to reach an operator's own, manually-
  // logged-in VisitSaudi Chrome session -- reached ONLY via that
  // operator's own reverse SSH tunnel (see scripts/windows/README.md);
  // this server-side process never opens a port of its own for this, and
  // never stores or transmits a credential. Optional and unset by
  // default: visaStartSubmissionCommand.ts's own getConfiguredVisitSaudiSession
  // falls back to getNoActiveVisitSaudiSession (always unavailable)
  // whenever this is unset, so /visa_start_submission ships OFF until an
  // operator explicitly configures this.
  VISITSAUDI_CDP_ENDPOINT: z.string().url().optional(),
  // Per-request timeout (ms) applied to every Google Sheets/Drive API call
  // this pipeline makes (see src/sheets/sheetsAuth.ts's
  // getConfiguredApiTimeoutMs()). Bounds how long one stuck/slow Google API
  // call can block the sheets sync worker's current job — without this, a
  // single hung request could stall the whole poll loop indefinitely. 30s
  // is generous headroom for a normal Sheets/Drive call.
  GOOGLE_SHEETS_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // A plain service account (no Google Workspace domain-wide delegation)
  // has zero Drive storage quota, so it cannot create a new spreadsheet
  // itself — see src/sheets/appsScriptProvisioning.ts's own doc comment.
  // Instead, a small Apps Script Web App bound to a real Google account
  // creates the file (under that account's own quota) and returns its id.
  // Optional for the same reason as the Sheets vars above — only
  // ensureGroupSheet.ts's new-provisioning path enforces these, and only
  // once it actually needs to create a spreadsheet.
  APPS_SCRIPT_WEB_APP_URL: z.string().url().optional(),
  // Shared secret sent in every request body to the Apps Script Web App
  // (never a header — Apps Script's doPost cannot read custom headers —
  // and never a URL query parameter). Must match the value configured in
  // that Apps Script project's own Script Properties.
  APPS_SCRIPT_SHARED_SECRET: z.string().min(1).optional(),
  // Id of the single, shared Google Spreadsheet that the target
  // "one master file, one tab per Telegram group" architecture will use
  // (via the Apps Script `ensureTab` action) instead of provisioning a
  // dedicated spreadsheet file per group. Reserved for that future change
  // only — nothing in this codebase reads this value yet, and no existing
  // provisioning/sync logic is affected by setting or leaving it unset.
  GOOGLE_SHEETS_MASTER_SPREADSHEET_ID: z.string().min(1).optional(),
  // Private GCS bucket for applicant personal photos (see
  // src/visa/uploadApplicantPhoto.ts). Optional here for the same reason
  // as every other Google credential var above — the OCR worker enforces
  // its presence itself, only once a photo upload is actually attempted,
  // and treats "not configured" as "skip photo storage" rather than an
  // error (this feature is opt-in per environment).
  GCS_VISA_PHOTOS_BUCKET: z.string().min(1).optional(),
  // Path to the DEDICATED visa-photos service account's JSON key file —
  // deliberately a separate credential from GOOGLE_SHEETS_SERVICE_ACCOUNT_
  // KEY_FILE (least-privilege: this one can only touch the one photos
  // bucket, never Sheets/Drive, and vice versa).
  GCS_VISA_PHOTOS_SERVICE_ACCOUNT_KEY_FILE: z.string().min(1).optional(),
  // This server's own public base URL (e.g. "https://visa.mahbubtour.uz"),
  // used only to build the durable /visa-photos/:token link written into
  // Sheet column T (see src/visa/applicantPhotoUrl.ts) — never used to
  // reach the bucket itself. No trailing slash expected.
  VISA_PHOTOS_PUBLIC_BASE_URL: z.string().url().optional(),
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
