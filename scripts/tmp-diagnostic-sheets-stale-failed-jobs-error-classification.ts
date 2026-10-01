/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY: a single SELECT of last_error for the 3 known stale 'failed'
 * sheet_sync_queue jobs from earlier debugging. The raw error text is NEVER
 * printed or logged anywhere -- it is read into memory, classified against
 * a fixed set of safe keyword categories (permission, not-found, timeout,
 * network, Apps Script/config, quota, validation), and only the resulting
 * booleans + a canned safe description per matched category are printed.
 * This is deliberately more conservative than earlier diagnostics in this
 * session (which printed sanitized/truncated error text): here the text
 * could in principle echo a URL, folder id, or other config detail from the
 * pre-Apps-Script debugging era, so nothing derived from its content beyond
 * keyword-match booleans ever reaches stdout.
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never touches Google
 * Sheets/Drive/Apps Script, never starts the worker, never invokes any OCR
 * provider (Tesseract or Google Vision).
 *
 * PRIVACY: raw last_error text is read but never printed, logged, or
 * returned in any form -- only its length and a set of category booleans
 * (each backed by a generic, non-content-derived description) are printed.
 */
import { pool } from '../src/db/pool.js';

const JOB_IDS = [
  '37c616ad-7548-4748-b174-35f763b8e084',
  '6431e8ac-ac32-4c00-8628-abd5fe0a6614',
  '8c77e99f-e0ca-4871-be0d-73b30c84a1f4',
];

interface Category {
  key: string;
  pattern: RegExp;
  description: string;
}

const CATEGORIES: Category[] = [
  {
    key: 'permission',
    pattern: /permission|forbidden|unauthorized|access denied|401|403/i,
    description: 'Google API ruxsat/permission xatosi (401/403 turkumi) -- odatda service account yoki OAuth scope yetarli emasligini bildiradi.',
  },
  {
    key: 'not_found',
    pattern: /not found|404|no such file|does not exist/i,
    description: 'Resurs topilmadi (404 turkumi) -- masalan noto‘g‘ri yoki hali yaratilmagan spreadsheet/fayl id.',
  },
  {
    key: 'timeout_network',
    pattern: /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|network/i,
    description: 'Tarmoq yoki timeout xatosi -- vaqtinchalik ulanish muammosi bo‘lishi mumkin.',
  },
  {
    key: 'apps_script',
    pattern: /apps script|doPost|web app|shared secret|requestId/i,
    description: 'Apps Script provisioning oqimiga oid xato (bu 3 ta job Apps Script integratsiyasi mavjud bo‘lishidan OLDIN yaratilgan edi).',
  },
  {
    key: 'config',
    pattern: /not configured|drive_folder_id|folder/i,
    description: 'Konfiguratsiya muammosi (masalan Drive folder sozlanmagan) -- hozir shu konfiguratsiya deploy qilinganini alohida tekshirish kerak.',
  },
  {
    key: 'quota',
    pattern: /quota|rate limit|429|storage quota/i,
    description: 'Kvota yoki rate-limit xatosi -- ayni root-cause (service account\'ning Drive storage kvotasi yo‘qligi) shu turkumga mos kelishi mumkin.',
  },
  {
    key: 'validation',
    pattern: /invalid|malformed|zod|schema|parse/i,
    description: 'Validatsiya/format xatosi -- so‘rov yoki javob formatiga oid muammo.',
  },
];

interface JobRow {
  id: string;
  status: string;
  attempts: number;
  last_error: string | null;
}

function classify(lastError: string): { matched: string[]; length: number } {
  const matched = CATEGORIES.filter((category) => category.pattern.test(lastError)).map((category) => category.key);
  return { matched, length: lastError.length };
}

async function main(): Promise<void> {
  const { rows } = await pool.query<JobRow>(
    `SELECT id, status, attempts, last_error FROM sheet_sync_queue WHERE id = ANY($1::uuid[])`,
    [JOB_IDS],
  );

  console.log('[stale-failed-error-classification] === per-job safe error classification (raw text never printed) ===');
  for (const jobId of JOB_IDS) {
    const row = rows.find((r) => r.id === jobId);
    if (!row) {
      console.log(`[stale-failed-error-classification] job_id=${jobId}: NOT FOUND (unexpected)`);
      continue;
    }
    console.log(`[stale-failed-error-classification] job_id=${row.id}  status=${row.status}  attempts=${row.attempts}`);
    if (!row.last_error) {
      console.log('[stale-failed-error-classification]   last_error: (null) -- no error text recorded');
      continue;
    }
    const { matched, length } = classify(row.last_error);
    console.log(`[stale-failed-error-classification]   last_error length: ${length} characters`);
    if (matched.length === 0) {
      console.log('[stale-failed-error-classification]   matched categories: none of the known keyword categories matched (unclassified)');
    } else {
      for (const key of matched) {
        const category = CATEGORIES.find((c) => c.key === key)!;
        console.log(`[stale-failed-error-classification]   matched category: ${category.key} -- ${category.description}`);
      }
    }
    const permissionOrConfigRelated = matched.some((key) => key === 'permission' || key === 'apps_script' || key === 'config' || key === 'quota');
    console.log(`[stale-failed-error-classification]   looks permission/config/Apps-Script/quota related: ${permissionOrConfigRelated}`);
  }

  console.log('[stale-failed-error-classification] DONE -- read-only, nothing was created, modified, or deleted. Raw error text was never printed.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[stale-failed-error-classification] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
