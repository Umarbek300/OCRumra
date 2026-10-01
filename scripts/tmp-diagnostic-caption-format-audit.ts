/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR/Sheets
 * pipeline. Never imported by src/, never wired into any worker.
 *
 * Purpose: compare what parsePackageDeposit.ts's regexes actually expect
 * against what real telegram_messages.caption_text rows in production
 * actually contain, to root-cause why packageText/depositText have been
 * coming out blank for real messages.
 *
 * READ-ONLY: only SELECT against telegram_messages. Calls the existing,
 * unmodified parsePackageAndDeposit()/calculateBalance() functions purely
 * as pure, in-memory functions (no DB/network side effect of their own).
 * No INSERT/UPDATE/DELETE, no Sheets API call, no service interaction, no
 * Tesseract/local OCR.
 *
 * PRIVACY: caption_text can contain real business terms (package tier,
 * amounts) that the requester asked not to be exposed verbatim. Every
 * digit in a printed caption is masked to '#' (preserving its length and
 * surrounding structure/keywords, which is exactly what's needed to
 * compare against the parser's patterns) -- the real numeric values are
 * never printed. No passport/OCR field is read or printed here at all
 * (this script only touches telegram_messages, never passport_ocr_results).
 */
import { pool } from '../src/db/pool.js';
import { calculateBalance, parsePackageAndDeposit } from '../src/telegram/parsePackageDeposit.js';

const SAMPLE_LIMIT = 30;

function maskDigits(text: string): string {
  return text.replace(/\d/g, '#');
}

interface CaptionRow {
  id: string;
  caption_text: string;
  created_at: Date | string;
}

async function main(): Promise<void> {
  console.log('[caption-format-audit] === real telegram_messages.caption_text rows vs. parsePackageDeposit.ts expectations ===');

  const { rows } = await pool.query<CaptionRow>(
    `SELECT id, caption_text, created_at
     FROM telegram_messages
     WHERE caption_text IS NOT NULL AND caption_text != ''
     ORDER BY created_at DESC
     LIMIT $1`,
    [SAMPLE_LIMIT],
  );

  console.log(`[caption-format-audit] non-empty captions found (most recent ${SAMPLE_LIMIT}): ${rows.length}`);

  let packageMatchCount = 0;
  let depositMatchCount = 0;
  let bothMatchCount = 0;
  let neitherMatchCount = 0;

  for (const row of rows) {
    const masked = maskDigits(row.caption_text);
    const hasPackageKeyword = /\b(package|paket)\b/i.test(row.caption_text);
    const hasDepositKeyword = /\b(deposit|depozit)\b/i.test(row.caption_text);
    const hasCurrencySymbol = /[$€£]/.test(row.caption_text);
    const hasTierWord = /\b(standard|premium|vip|business|economy|econom|deluxe|basic)\b/i.test(row.caption_text);

    const parsed = parsePackageAndDeposit(row.caption_text);
    const balance = calculateBalance(parsed.packageAmount, parsed.depositAmount);

    if (parsed.packageAmount) packageMatchCount += 1;
    if (parsed.depositAmount) depositMatchCount += 1;
    if (parsed.packageAmount && parsed.depositAmount) bothMatchCount += 1;
    if (!parsed.packageAmount && !parsed.depositAmount) neitherMatchCount += 1;

    console.log(
      `[caption-format-audit]   message_id=${row.id}  created_at=${row.created_at}  ` +
        `length=${row.caption_text.length}  has_package_keyword=${hasPackageKeyword}  has_deposit_keyword=${hasDepositKeyword}  ` +
        `has_currency_symbol=${hasCurrencySymbol}  has_tier_word=${hasTierWord}`,
    );
    console.log(`[caption-format-audit]     masked_caption: ${JSON.stringify(masked)}`);
    console.log(
      `[caption-format-audit]     parser_result: package_matched=${!!parsed.packageAmount}  deposit_matched=${!!parsed.depositAmount}  balance_computed=${!!balance}`,
    );
  }

  console.log('[caption-format-audit] === summary across the sample ===');
  console.log(`[caption-format-audit]   total captions checked: ${rows.length}`);
  console.log(`[caption-format-audit]   package matched: ${packageMatchCount}`);
  console.log(`[caption-format-audit]   deposit matched: ${depositMatchCount}`);
  console.log(`[caption-format-audit]   both matched (balance computable): ${bothMatchCount}`);
  console.log(`[caption-format-audit]   neither matched: ${neitherMatchCount}`);

  console.log('[caption-format-audit] DONE -- read-only, nothing was created, modified, or deleted.');
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[caption-format-audit] FAILED:', message.slice(0, 500));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
