/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * READ-ONLY: a single spreadsheets.values.get on A2:M2 of the one
 * spreadsheet already created and verified in this work
 * (16oTz3UkPqYIlyiqk3Gv-4CA9Le1uIw0DSeO7ItecPWs). Never writes, never
 * touches the DB, never calls OCR, never starts the worker.
 *
 * Uses the EXISTING, unmodified sheetLayout.ts column contract
 * (VISIBLE_COLUMN_HEADERS + TECHNICAL_ID_HEADER, fullRowRange) as the
 * source of truth for which column is which — never a hand-typed mapping.
 *
 * PRIVACY: never prints the actual passport-derived value of any column
 * except A (№, a plain row-position integer) and M (a telegram_message_id
 * UUID, already known/shared elsewhere in this work) — neither is
 * passport PII. For columns B..L (Ism, Familiya, Passport №, dates, Jins,
 * Agent, Paket, Depozit, Qoldiq) this only prints whether the cell is
 * non-empty and its character length — never its content.
 */
import { getSheetsClients } from '../src/sheets/sheetsAuth.js';
import { fullRowRange, TECHNICAL_ID_HEADER, VISIBLE_COLUMN_HEADERS } from '../src/sheets/sheetLayout.js';

const SPREADSHEET_ID = '16oTz3UkPqYIlyiqk3Gv-4CA9Le1uIw0DSeO7ItecPWs';
const EXPECTED_TELEGRAM_MESSAGE_ID = '3b935c47-b3a6-4d91-aa78-2106abaf436b';

const ALL_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'] as const;
const ALL_LABELS: readonly string[] = [...VISIBLE_COLUMN_HEADERS, TECHNICAL_ID_HEADER];

async function main(): Promise<void> {
  const { sheets } = getSheetsClients();
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: fullRowRange(2) });
  const row = response.data.values?.[0] ?? [];

  console.log('[row2-mapping-check] spreadsheetId:', SPREADSHEET_ID);
  console.log('[row2-mapping-check] row length (expected 13):', row.length);

  for (let i = 0; i < ALL_LETTERS.length; i++) {
    const letter = ALL_LETTERS[i]!;
    const label = ALL_LABELS[i]!;
    const value = row[i];

    if (letter === 'A') {
      // № -- a small row-position integer, not PII, safe to print in full.
      console.log(`[row2-mapping-check] ${letter} (${label}): value=${value ?? '(empty)'}`);
    } else if (letter === 'M') {
      // technical id -- a UUID, not PII, safe to print and directly comparable.
      console.log(
        `[row2-mapping-check] ${letter} (${label}): value=${value ?? '(empty)'}  matches_expected_telegram_message_id=${
          value === EXPECTED_TELEGRAM_MESSAGE_ID
        }`,
      );
    } else {
      // B..L may hold passport-derived data -- never print the value, only structural signal.
      const nonEmpty = typeof value === 'string' && value.length > 0;
      console.log(`[row2-mapping-check] ${letter} (${label}): non_empty=${nonEmpty}  length=${nonEmpty ? value.length : 0}`);
    }
  }

  console.log('[row2-mapping-check] DONE -- read-only, nothing was created, modified, or deleted.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error('[row2-mapping-check] FAILED:', message.slice(0, 300));
  process.exitCode = 1;
});
