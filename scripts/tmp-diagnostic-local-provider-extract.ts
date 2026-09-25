/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * Calls the EXISTING, unmodified-in-scope production `createLocalProvider()`
 * (the Step-1 per-candidate pipeline) directly against real Telegram photo
 * buffers, to see whether the new per-candidate fallback logic recovers a
 * readable MRZ for documents the old pipeline failed on. Never touches the
 * Redis queue or writes to the database — read-only DB lookup, in-memory
 * download, direct function call. The pipeline's own internal
 * `[mrz-pipeline]` logs (candidate/stage/lineCount/lengths/parseSuccess/
 * winner) already carry the per-candidate detail and are PII-safe by
 * construction (see tests/ocr.localProvider.test.ts); this script adds only
 * a final structural summary (field presence + confidence, never values).
 */
import { createLocalProvider } from '../src/ocr/providers/localProvider.js';
import type { ClaudePassportResponse, ConfidenceLevel, PassportExtractionResult } from '../src/ocr/passportExtractionSchema.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

const FIELD_NAMES = [
  'firstName',
  'middleName',
  'surname',
  'passportNumber',
  'dateOfBirth',
  'passportIssueDate',
  'passportExpiryDate',
  'gender',
  'nationality',
  'placeOfBirth',
  'issuingAuthority',
  'mrz',
] as const satisfies readonly (keyof ClaudePassportResponse)[];

export interface FieldPresenceSummary {
  present: boolean;
  confidence: ConfidenceLevel | null;
}

export interface LocalProviderExtractDiagnosticResult {
  overallConfidence: ConfidenceLevel;
  model: string;
  fields: Record<(typeof FIELD_NAMES)[number], FieldPresenceSummary>;
  processingTimeMs: number;
}

export type ExtractFn = (imageBuffer: Buffer) => Promise<PassportExtractionResult>;

export async function runLocalProviderExtractDiagnostic(
  imageBuffer: Buffer,
  extract: ExtractFn,
): Promise<LocalProviderExtractDiagnosticResult> {
  const start = Date.now();
  const result = await extract(imageBuffer);
  const processingTimeMs = Date.now() - start;

  const fields = {} as LocalProviderExtractDiagnosticResult['fields'];
  for (const field of FIELD_NAMES) {
    const entry = result[field];
    fields[field] = { present: entry.value !== null, confidence: entry.confidence };
  }

  return {
    overallConfidence: result.overallConfidence,
    model: result.model,
    fields,
    processingTimeMs,
  };
}

export function formatLocalProviderExtractDiagnosticResult(result: LocalProviderExtractDiagnosticResult): string {
  const fieldLines = FIELD_NAMES.map((name) => {
    const { present, confidence } = result.fields[name];
    return `  ${name}: present=${present} confidence=${confidence ?? 'null'}`;
  });
  return [
    `model=${result.model}`,
    `overallConfidence=${result.overallConfidence}`,
    `processingTimeMs=${result.processingTimeMs}`,
    'fields:',
    ...fieldLines,
  ].join('\n');
}

async function main(): Promise<void> {
  const messageIds = process.argv.slice(2);
  if (messageIds.length === 0) {
    console.error(
      'Usage: tsx scripts/tmp-diagnostic-local-provider-extract.ts <telegram_messages.id> [<telegram_messages.id> ...]',
    );
    process.exitCode = 1;
    return;
  }

  const provider = createLocalProvider();

  try {
    for (const messageId of messageIds) {
      console.log(`\n[local-provider-extract] ===== message=${messageId} =====`);

      const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
        'SELECT telegram_photo_file_id FROM telegram_messages WHERE id = $1',
        [messageId],
      );
      const row = queryResult.rows[0];
      if (!row) {
        console.error(`[local-provider-extract] no telegram_messages row found for id=${messageId}`);
        continue;
      }

      const { buffer, mimeType } = await downloadTelegramPhoto(row.telegram_photo_file_id);
      const diagnosticResult = await runLocalProviderExtractDiagnostic(buffer, (imageBuffer) =>
        provider.extract(imageBuffer, mimeType),
      );

      console.log('\n[local-provider-extract] SUMMARY (PII-safe — no names, numbers, dates, or raw MRZ text):\n');
      console.log(formatLocalProviderExtractDiagnosticResult(diagnosticResult));
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-local-provider-extract.ts')) {
  main().catch((error) => {
    console.error('[local-provider-extract] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
