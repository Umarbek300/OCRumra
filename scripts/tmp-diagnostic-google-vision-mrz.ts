/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * A/B test scaffold: runs a real passport photo through Google Cloud
 * Vision's DOCUMENT_TEXT_DETECTION instead of the local Tesseract
 * pipeline, extracts MRZ candidate line-pairs from the returned full-page
 * text, and validates them with the EXISTING, unmodified
 * parseAndValidateMrz() — the same checksum-based validation the Tesseract
 * pipeline uses, so the two providers' real-world MRZ recovery can be
 * compared apples-to-apples later. Read-only: no DB writes, no Redis, no
 * worker/bot involvement. Never logs OCR'd text, MRZ line values, or
 * credential/token content — only structural facts (line lengths,
 * boolean checks, success/failure, latency).
 *
 * GOOGLE_APPLICATION_CREDENTIALS is read automatically by
 * @google-cloud/vision's client (Application Default Credentials) — this
 * file never references the credential file path directly.
 */
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import { getImageDimensions } from '../src/ocr/mrz/getImageDimensions.js';
import { looksLikeMrzLine } from '../src/ocr/mrz/looksLikeMrzLine.js';
import { normalizeMrzLineLength } from '../src/ocr/mrz/normalizeMrzLine.js';
import { parseAndValidateMrz } from '../src/ocr/mrz/parseAndValidateMrz.js';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

const MAX_ERROR_MESSAGE_LENGTH = 300;
const MRZ_ALPHABET_PATTERN = /^[A-Z0-9<]+$/;
// Real TD3 MRZ lines are always 44 characters, but a Vision OCR read can be
// off by one or two (a dropped/duplicated trailing filler char) — this
// window is deliberately generous so a near-miss still reaches
// parseAndValidateMrz for real (checksum-based) validation, instead of
// being discarded purely on length. It only needs to be tight enough to
// exclude obviously non-MRZ text (short words, page headers).
const MIN_CANDIDATE_LENGTH = 30;
const MAX_CANDIDATE_LENGTH = 50;

/**
 * Looser than looksLikeMrzLine (which requires the exact 44-char TD3
 * length): only filters out lines that clearly aren't MRZ-shaped at all
 * (wrong alphabet, or far too short/long), so a window with a realistic
 * OCR length miss isn't discarded before parseAndValidateMrz ever sees it.
 */
function looksApproximatelyLikeMrzLine(line: string): boolean {
  return (
    line.length >= MIN_CANDIDATE_LENGTH &&
    line.length <= MAX_CANDIDATE_LENGTH &&
    MRZ_ALPHABET_PATTERN.test(line) &&
    line.includes('<')
  );
}

export interface MrzCandidateWindowMeta {
  windowIndex: number;
  rawLengths: [number, number];
  normalizedLengths: [number, number];
  looksLikeMrz: [boolean, boolean];
}

export interface MrzCandidateWindow {
  lines: [string, string];
  window: MrzCandidateWindowMeta;
}

/**
 * Splits Vision's full-page text into cleaned lines, then finds every
 * consecutive 2-line window that's plausibly MRZ-shaped. Each window's
 * lines are normalized (reusing the existing, unmodified
 * normalizeMrzLineLength) before being returned — the caller runs real
 * validation. looksLikeMrzLine is recorded per line as a structural signal
 * but never used to reject a window outright.
 */
export function findMrzCandidateWindows(fullText: string): MrzCandidateWindow[] {
  const cleanedLines = fullText
    .split('\n')
    .map((line) => line.replace(/\s+/g, '').toUpperCase())
    .filter((line) => line.length > 0);

  const windows: MrzCandidateWindow[] = [];
  for (let i = 0; i < cleanedLines.length - 1; i++) {
    const rawA = cleanedLines[i]!;
    const rawB = cleanedLines[i + 1]!;
    if (!looksApproximatelyLikeMrzLine(rawA) || !looksApproximatelyLikeMrzLine(rawB)) continue;

    const normalizedA = normalizeMrzLineLength(rawA);
    const normalizedB = normalizeMrzLineLength(rawB);

    windows.push({
      lines: [normalizedA, normalizedB],
      window: {
        windowIndex: i,
        rawLengths: [rawA.length, rawB.length],
        normalizedLengths: [normalizedA.length, normalizedB.length],
        looksLikeMrz: [looksLikeMrzLine(normalizedA), looksLikeMrzLine(normalizedB)],
      },
    });
  }
  return windows;
}

export type DetectDocumentTextFn = (imageBuffer: Buffer) => Promise<string>;

export interface GoogleVisionMrzCandidateResult extends MrzCandidateWindowMeta {
  parseSuccess: boolean;
}

export interface GoogleVisionMrzDiagnosticResult {
  visionSuccess: boolean;
  visionErrorReason: string | null;
  candidateCount: number;
  candidates: GoogleVisionMrzCandidateResult[];
  winnerWindowIndex: number | null;
  latencyMs: number;
}

function sanitizeErrorReason(error: unknown): string {
  // Bounded the same way runTesseractOcr.ts bounds stderr — defense in
  // depth, even though Google's own error messages only ever describe
  // API/auth/quota state, never document content.
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * Runs the full diagnostic against one image buffer: calls the injected
 * Vision text-detection function, extracts MRZ candidate windows, and
 * validates each with the existing, unmodified parseAndValidateMrz().
 * Never throws — a Vision API failure (including a missing-credentials
 * error) is reported as a structured, PII-safe result, not an exception.
 */
export async function runGoogleVisionMrzDiagnostic(
  imageBuffer: Buffer,
  detectDocumentText: DetectDocumentTextFn,
): Promise<GoogleVisionMrzDiagnosticResult> {
  const start = Date.now();
  let fullText: string;
  try {
    fullText = await detectDocumentText(imageBuffer);
  } catch (error) {
    return {
      visionSuccess: false,
      visionErrorReason: sanitizeErrorReason(error),
      candidateCount: 0,
      candidates: [],
      winnerWindowIndex: null,
      latencyMs: Date.now() - start,
    };
  }
  const latencyMs = Date.now() - start;

  const windows = findMrzCandidateWindows(fullText);
  const candidates: GoogleVisionMrzCandidateResult[] = [];
  let winnerWindowIndex: number | null = null;

  for (const { lines, window } of windows) {
    const parsed = parseAndValidateMrz(lines);
    const parseSuccess = parsed !== null;
    candidates.push({ ...window, parseSuccess });
    if (parseSuccess && winnerWindowIndex === null) {
      winnerWindowIndex = window.windowIndex;
    }
  }

  return {
    visionSuccess: true,
    visionErrorReason: null,
    candidateCount: candidates.length,
    candidates,
    winnerWindowIndex,
    latencyMs,
  };
}

export function formatGoogleVisionMrzDiagnosticResult(result: GoogleVisionMrzDiagnosticResult): string {
  const candidateLines = result.candidates.map(
    (c) =>
      `  windowIndex=${c.windowIndex} rawLengths=[${c.rawLengths.join(',')}] normalizedLengths=[${c.normalizedLengths.join(',')}] looksLikeMrz=[${c.looksLikeMrz.join(',')}] parseSuccess=${c.parseSuccess}`,
  );
  return [
    `visionSuccess=${result.visionSuccess}`,
    `visionErrorReason=${result.visionErrorReason ?? 'null'}`,
    `candidateCount=${result.candidateCount}`,
    `winnerWindowIndex=${result.winnerWindowIndex ?? 'null'}`,
    `latencyMs=${result.latencyMs}`,
    'candidates:',
    ...candidateLines,
  ].join('\n');
}

let realVisionClient: ImageAnnotatorClient | null = null;
function getRealVisionClient(): ImageAnnotatorClient {
  if (!realVisionClient) {
    realVisionClient = new ImageAnnotatorClient();
  }
  return realVisionClient;
}

/**
 * Real Vision call — minimal DOCUMENT_TEXT_DETECTION request (just the
 * image buffer, no extra feature types or image context).
 * GOOGLE_APPLICATION_CREDENTIALS is read automatically by the client
 * library; this function never references the credential path itself.
 */
async function detectDocumentTextReal(imageBuffer: Buffer): Promise<string> {
  const client = getRealVisionClient();
  const [response]: [protos.google.cloud.vision.v1.IAnnotateImageResponse] =
    await client.documentTextDetection(imageBuffer);
  if (response.error?.message) {
    throw new Error(response.error.message);
  }
  return response.fullTextAnnotation?.text ?? '';
}

/**
 * Derives a coarse, PII-free error category from an error message for
 * CLI reporting — never prints the message content beyond what
 * visionErrorReason already carries (itself bounded/truncated). Purely a
 * presentation helper; does not affect the tested diagnostic result shape.
 */
function classifyErrorType(message: string): string {
  const grpcStatusMatch = /^\d*\s*([A-Z_]{3,})\s*:/.exec(message);
  if (grpcStatusMatch?.[1]) return grpcStatusMatch[1];
  if (/credential/i.test(message)) return 'CREDENTIALS_ERROR';
  if (/ENOTFOUND|ECONNREFUSED|network/i.test(message)) return 'NETWORK_ERROR';
  return 'UNKNOWN_ERROR';
}

async function runForMessage(messageId: string): Promise<void> {
  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    'SELECT telegram_photo_file_id FROM telegram_messages WHERE id = $1',
    [messageId],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.error(`[google-vision-mrz] message=${messageId}: no telegram_messages row found`);
    return;
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);
  const { width, height } = await getImageDimensions(buffer);
  const result = await runGoogleVisionMrzDiagnostic(buffer, detectDocumentTextReal);

  console.log(`\n[google-vision-mrz] ===== message=${messageId} =====`);
  console.log(`[google-vision-mrz] image=${width}x${height}`);
  console.log('[google-vision-mrz] SUMMARY (PII-safe — no OCR text, MRZ values, or credentials):\n');
  console.log(formatGoogleVisionMrzDiagnosticResult(result));
  if (!result.visionSuccess && result.visionErrorReason) {
    console.log(`errorType=${classifyErrorType(result.visionErrorReason)}`);
  }
}

async function main(): Promise<void> {
  const messageIds = process.argv.slice(2);
  if (messageIds.length === 0) {
    console.error('Usage: tsx scripts/tmp-diagnostic-google-vision-mrz.ts <telegram_messages.id> [<telegram_messages.id> ...]');
    process.exitCode = 1;
    return;
  }

  try {
    for (const messageId of messageIds) {
      await runForMessage(messageId);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-google-vision-mrz.ts')) {
  main().catch((error) => {
    console.error('[google-vision-mrz] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
