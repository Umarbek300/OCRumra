/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY OCR-completeness audit for the telegram_message linked to the
 * third of the 3 known stale 'failed' sheet_sync_queue jobs from earlier
 * debugging, alongside c1e13e5b/37c616ad and 4d1a8bec/6431e8ac -- this is
 * the one candidate never individually characterized in this session.
 * "d0391ed8" is actually the telegram_message_id prefix for that job
 * (job_id=8c77e99f-e0ca-4871-be0d-73b30c84a1f4), confirmed by the earlier
 * pre-worker sheet_sync_queue audit in this session -- this script matches
 * the prefix against BOTH id and telegram_message_id so it resolves
 * correctly either way.
 *
 * Only DB SELECTs. Resolves the telegram_message_id via sheet_sync_queue
 * (prefix match against either column), then:
 *   1) reads passport_ocr_results.provider and overall_confidence,
 *   2) checks NULL/NOT_NULL for the 7 core fields (first_name, surname,
 *      passport_number, date_of_birth, passport_issue_date,
 *      passport_expiry_date, gender),
 *   3) reports on Paket/Agent/Depozit/Qoldiq: per buildSheetRow.ts (read,
 *      not modified), Paket/Depozit/Qoldiq are ALWAYS written as '' by this
 *      pipeline -- they are operator-entered directly in the sheet, never
 *      sourced from the DB, so there is nothing to query for those two.
 *      Agent is real: sourced from telegram_messages.agent_id -> agents.name
 *      -- this script checks only whether that link/row exists, never
 *      prints the agent's name,
 *   4) summarizes overall completeness and lists which of the 7 core fields
 *      (if any) are empty.
 *
 * Never INSERTs/UPDATEs/DELETEs anything, never touches Google
 * Sheets/Drive/Apps Script, never starts the worker, never invokes any OCR
 * provider (Tesseract or Google Vision).
 *
 * PRIVACY: never selects or prints the actual value of any passport field,
 * date, or agent name -- only booleans (present/absent), the provider name
 * and confidence level (metadata, not passport content), and internal
 * UUIDs.
 */
import { pool } from '../src/db/pool.js';

const ID_PREFIX = 'd0391ed8';

interface JobLookupRow {
  job_id: string;
  telegram_message_id: string;
}

interface OcrRow {
  provider: string;
  overall_confidence: string;
  has_first_name: boolean;
  has_surname: boolean;
  has_passport_number: boolean;
  has_date_of_birth: boolean;
  has_passport_issue_date: boolean;
  has_passport_expiry_date: boolean;
  has_gender: boolean;
}

interface AgentLinkRow {
  has_agent_id: boolean;
  agent_row_found: boolean | null;
}

async function main(): Promise<void> {
  console.log('[d0391ed8-completeness-audit] === STEP 1: resolve telegram_message_id via sheet_sync_queue ===');
  const { rows: jobRows } = await pool.query<JobLookupRow>(
    `SELECT id AS job_id, telegram_message_id
     FROM sheet_sync_queue
     WHERE id::text LIKE $1 OR telegram_message_id::text LIKE $1`,
    [`${ID_PREFIX}%`],
  );
  const job = jobRows[0];
  if (!job) {
    console.log(`[d0391ed8-completeness-audit] no sheet_sync_queue job found with id or telegram_message_id starting with "${ID_PREFIX}" -- stopping.`);
    return;
  }
  if (jobRows.length > 1) {
    console.log(`[d0391ed8-completeness-audit] WARNING: ${jobRows.length} jobs matched this prefix (expected 1) -- using the first.`);
  }
  console.log('[d0391ed8-completeness-audit] job_id:', job.job_id);
  console.log('[d0391ed8-completeness-audit] telegram_message_id:', job.telegram_message_id);

  console.log('[d0391ed8-completeness-audit] === STEP 2: OCR provider / confidence / 7 core fields ===');
  const { rows: ocrRows } = await pool.query<OcrRow>(
    `SELECT
       provider,
       overall_confidence,
       (first_name IS NOT NULL) AS has_first_name,
       (surname IS NOT NULL) AS has_surname,
       (passport_number IS NOT NULL) AS has_passport_number,
       (date_of_birth IS NOT NULL) AS has_date_of_birth,
       (passport_issue_date IS NOT NULL) AS has_passport_issue_date,
       (passport_expiry_date IS NOT NULL) AS has_passport_expiry_date,
       (gender IS NOT NULL) AS has_gender
     FROM passport_ocr_results
     WHERE telegram_message_id = $1`,
    [job.telegram_message_id],
  );
  const ocr = ocrRows[0];
  if (!ocr) {
    console.log('[d0391ed8-completeness-audit] no passport_ocr_results row found for this telegram_message_id.');
    return;
  }
  console.log('[d0391ed8-completeness-audit] provider:', ocr.provider);
  console.log('[d0391ed8-completeness-audit] overall_confidence:', ocr.overall_confidence);

  const fieldChecks: Array<[string, boolean]> = [
    ['first_name', ocr.has_first_name],
    ['surname', ocr.has_surname],
    ['passport_number', ocr.has_passport_number],
    ['date_of_birth', ocr.has_date_of_birth],
    ['passport_issue_date', ocr.has_passport_issue_date],
    ['passport_expiry_date', ocr.has_passport_expiry_date],
    ['gender', ocr.has_gender],
  ];
  for (const [name, present] of fieldChecks) {
    console.log(`[d0391ed8-completeness-audit]   ${name}: ${present ? 'present' : 'EMPTY'}`);
  }

  console.log('[d0391ed8-completeness-audit] === STEP 3: Paket / Agent / Depozit / Qoldiq ===');
  console.log(
    '[d0391ed8-completeness-audit]   Paket/Depozit/Qoldiq: per src/sheets/buildSheetRow.ts (read-only code fact, not ' +
      'a per-record DB check) these 3 columns are ALWAYS written as \'\' by this pipeline -- operator-entered directly ' +
      'in the sheet, never sourced from any DB table. Nothing to query for this specific message.',
  );
  const { rows: agentRows } = await pool.query<AgentLinkRow>(
    `SELECT
       (tm.agent_id IS NOT NULL) AS has_agent_id,
       (a.id IS NOT NULL) AS agent_row_found
     FROM telegram_messages tm
     LEFT JOIN agents a ON a.id = tm.agent_id
     WHERE tm.id = $1`,
    [job.telegram_message_id],
  );
  const agentLink = agentRows[0];
  if (!agentLink) {
    console.log('[d0391ed8-completeness-audit]   Agent: telegram_message row not found (unexpected).');
  } else {
    console.log(`[d0391ed8-completeness-audit]   Agent: telegram_message has agent_id=${agentLink.has_agent_id}, linked agents row found=${agentLink.agent_row_found ?? false} (name never printed).`);
  }

  console.log('[d0391ed8-completeness-audit] === STEP 4: overall completeness summary ===');
  const emptyFields = fieldChecks.filter(([, present]) => !present).map(([name]) => name);
  console.log(`[d0391ed8-completeness-audit]   ${fieldChecks.length - emptyFields.length} of ${fieldChecks.length} core fields present.`);
  if (emptyFields.length === 0) {
    console.log('[d0391ed8-completeness-audit]   all 7 core fields present -- fully complete.');
  } else {
    console.log('[d0391ed8-completeness-audit]   empty fields:', emptyFields.join(', '));
  }

  console.log('[d0391ed8-completeness-audit] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[d0391ed8-completeness-audit] FAILED:', message.slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
