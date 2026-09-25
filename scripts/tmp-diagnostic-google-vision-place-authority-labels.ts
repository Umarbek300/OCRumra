/**
 * TEMPORARY ONE-OFF DIAGNOSTIC — not part of the production OCR pipeline.
 * Never imported by src/, never wired into the worker/bot.
 *
 * Question this answers: for each PLACE OF BIRTH / BIRTH PLACE / BIRTHPLACE
 * / AUTHORITY / ISSUING AUTHORITY / ISSUED BY label found in Google
 * Vision's structured `pages` response, what is the actual geometric
 * relationship (LEFT/RIGHT/ABOVE/BELOW/OVERLAP, same-row, gaps) between the
 * label and every nearby word -- WITHOUT assuming Vision's word/paragraph/
 * block iteration order matches visual reading order, and WITHOUT ever
 * printing the actual OCR text -- now across a LARGER real sample (10-25
 * messages, not just 270/271), to see whether the AUTHORITY=LEFT and
 * PLACE OF BIRTH=NEXT_ROW patterns found on 270/271 generalize.
 *
 * 4th pass. Earlier passes established (on messages 270/271 only):
 *  - both labels are present on real passports;
 *  - naive "nearest paragraph in block order" is NOT reliable -- Vision's
 *    block order does not guarantee top-to-bottom visual order;
 *  - AUTHORITY's same-row candidate sat to the LEFT of the label on both
 *    270 and 271;
 *  - PLACE OF BIRTH's answer differed between the two (270:
 *    NO_SAFE_CANDIDATE, 271: NEXT_ROW) -- not yet proven universal.
 * This pass adds an auto-selection mode (`--auto <count>`) that queries
 * real, already-successfully-processed passport messages from the
 * database (read-only SELECT only) instead of requiring hardcoded message
 * numbers, then runs the exact same per-label geometric analysis as
 * before across all of them, plus an aggregate count summary at the end.
 *
 * Scans EVERY block/paragraph on every page (not hardcoded to any index).
 * Makes exactly ONE documentTextDetection() call per message (no second
 * OCR call, no Tesseract). Read-only: no DB writes, no Redis, no
 * worker/bot involvement, no production file touched.
 *
 * PII SAFETY: this script NEVER prints actual OCR text for any real
 * message. It only prints: the Telegram message number (not PII -- a
 * per-chat sequence number, not a passport field), page/block/paragraph/
 * word index, the *normalized label name it matched against* (a fixed
 * vocabulary word this script defines itself), character-class shape
 * (DIGIT/LETTER/MIXED/OTHER) and length per word, normalized (0..1)
 * bounding-box coordinates, and derived geometric relationships/distances.
 * MRZ text is never read or printed by this script at all.
 */
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

/** Hard upper bound on how many real messages one invocation can pull/process -- cost and blast-radius guard, not a business rule. */
const MAX_AUTO_COUNT = 25;

// --- Minimal structural view of Vision's response shape --------------------
interface VisionVertex {
  x?: number | null;
  y?: number | null;
}
interface VisionBoundingPoly {
  vertices?: VisionVertex[] | null;
}
interface VisionSymbol {
  text?: string | null;
}
interface VisionWord {
  symbols?: VisionSymbol[] | null;
  boundingBox?: VisionBoundingPoly | null;
}
interface VisionParagraph {
  words?: VisionWord[] | null;
}
interface VisionBlock {
  paragraphs?: VisionParagraph[] | null;
}
interface VisionPage {
  blocks?: VisionBlock[] | null;
  width?: number | null;
  height?: number | null;
}

type CharClass = 'DIGIT' | 'LETTER' | 'MIXED' | 'OTHER';

function classifySymbolChar(char: string): 'DIGIT' | 'LETTER' | 'OTHER' {
  if (/^[0-9]$/.test(char)) return 'DIGIT';
  if (/^[A-Za-z]$/.test(char)) return 'LETTER';
  return 'OTHER';
}

function classifyWord(text: string): CharClass {
  if (text.length === 0) return 'OTHER';
  const classes = new Set([...text].map(classifySymbolChar));
  if (classes.size === 1) return [...classes][0] as CharClass;
  return 'MIXED';
}

function getWordText(word: VisionWord): string {
  return (word.symbols ?? []).map((symbol) => symbol.text ?? '').join('');
}

interface NormalizedBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function normalizeBox(box: VisionBoundingPoly | null | undefined, pageWidth: number, pageHeight: number): NormalizedBox | null {
  const vertices = box?.vertices;
  if (!vertices || vertices.length === 0 || pageWidth <= 0 || pageHeight <= 0) return null;
  const xs = vertices.map((v) => (v.x ?? 0) / pageWidth);
  const ys = vertices.map((v) => (v.y ?? 0) / pageHeight);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function formatBox(box: NormalizedBox | null): string {
  if (!box) return 'null';
  return `x0=${box.x0.toFixed(3)},y0=${box.y0.toFixed(3)},x1=${box.x1.toFixed(3)},y1=${box.y1.toFixed(3)}`;
}

function boxCenter(box: NormalizedBox): { x: number; y: number } {
  return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
}

/** 0 when the two boxes overlap horizontally; otherwise the gap between the nearer edges. */
function horizontalGap(a: NormalizedBox, b: NormalizedBox): number {
  if (a.x1 < b.x0) return b.x0 - a.x1;
  if (b.x1 < a.x0) return a.x0 - b.x1;
  return 0;
}

/** 0 when the two boxes overlap vertically; otherwise the gap between the nearer edges. */
function verticalGap(a: NormalizedBox, b: NormalizedBox): number {
  if (a.y1 < b.y0) return b.y0 - a.y1;
  if (b.y1 < a.y0) return a.y0 - b.y1;
  return 0;
}

// --- Normalization: case/punctuation/whitespace tolerant --------------------
/** Uppercases and strips everything but A-Z0-9, so trailing/embedded OCR punctuation never blocks a match. */
function normalizeToken(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

interface WordInfo {
  pageIndex: number;
  blockIndex: number;
  paragraphIndex: number;
  wordIndex: number;
  rawLength: number;
  charClass: CharClass;
  normalizedToken: string;
  box: NormalizedBox | null;
}

function flattenWords(pages: readonly VisionPage[]): WordInfo[] {
  const words: WordInfo[] = [];
  pages.forEach((page, pageIndex) => {
    const pageWidth = page.width ?? 0;
    const pageHeight = page.height ?? 0;
    (page.blocks ?? []).forEach((block, blockIndex) => {
      (block.paragraphs ?? []).forEach((paragraph, paragraphIndex) => {
        (paragraph.words ?? []).forEach((word, wordIndex) => {
          const text = getWordText(word);
          words.push({
            pageIndex,
            blockIndex,
            paragraphIndex,
            wordIndex,
            rawLength: text.length,
            charClass: classifyWord(text),
            normalizedToken: normalizeToken(text),
            box: normalizeBox(word.boundingBox, pageWidth, pageHeight),
          });
        });
      });
    });
  });
  return words;
}

/**
 * Target label vocabulary, as normalized (letters/digits-only, concatenated)
 * forms. A sliding window of 1..3 consecutive words within the same
 * paragraph is normalized and concatenated with no separator, covering both
 * "Vision returns it as one token" and "as separate words" uniformly.
 */
const TARGET_LABELS: Record<string, string> = {
  PLACEOFBIRTH: 'PLACE OF BIRTH',
  BIRTHPLACE: 'BIRTH PLACE / BIRTHPLACE',
  AUTHORITY: 'AUTHORITY',
  ISSUINGAUTHORITY: 'ISSUING AUTHORITY',
  ISSUEDBY: 'ISSUED BY',
};
const MAX_WINDOW_WORDS = 3;

interface LabelMatch {
  canonicalLabel: string;
  matchedForm: string;
  windowWordCount: number;
  words: WordInfo[];
}

function findLabelMatches(words: readonly WordInfo[]): LabelMatch[] {
  const byParagraph = new Map<string, WordInfo[]>();
  for (const word of words) {
    const key = `${word.pageIndex}:${word.blockIndex}:${word.paragraphIndex}`;
    const list = byParagraph.get(key) ?? [];
    list.push(word);
    byParagraph.set(key, list);
  }
  for (const list of byParagraph.values()) list.sort((a, b) => a.wordIndex - b.wordIndex);

  const matches: LabelMatch[] = [];
  for (const paragraphWords of byParagraph.values()) {
    for (let start = 0; start < paragraphWords.length; start++) {
      for (let windowSize = 1; windowSize <= MAX_WINDOW_WORDS; windowSize++) {
        if (start + windowSize > paragraphWords.length) break;
        const windowWords = paragraphWords.slice(start, start + windowSize);
        const joined = windowWords.map((w) => w.normalizedToken).join('');
        const canonicalLabel = TARGET_LABELS[joined];
        if (canonicalLabel) {
          matches.push({ canonicalLabel, matchedForm: joined, windowWordCount: windowSize, words: windowWords });
        }
      }
    }
  }
  return matches;
}

/** Multiple window sizes can match the same physical label (e.g. "AUTHORITY" alone and ":AUTHORITY" together) -- keep only the largest match per location. */
function dedupeMatches(matches: readonly LabelMatch[]): LabelMatch[] {
  const bestByKey = new Map<string, LabelMatch>();
  for (const match of matches) {
    const first = match.words[0]!;
    const key = `${match.canonicalLabel}:${first.pageIndex}:${first.blockIndex}:${first.paragraphIndex}`;
    const existing = bestByKey.get(key);
    if (!existing || match.windowWordCount > existing.windowWordCount) bestByKey.set(key, match);
  }
  return [...bestByKey.values()];
}

// --- Geometry-based neighbor analysis ---------------------------------------

const SAME_ROW_Y_TOLERANCE = 0.03; // normalized page-height units -- matches the row-alignment threshold used elsewhere in this codebase

type NeighborSource =
  | 'sameParagraph'
  | 'precedingParagraphSameBlock'
  | 'followingParagraphSameBlock'
  | 'precedingBlockLastParagraph'
  | 'followingBlockFirstParagraph';

interface NeighborWord {
  word: WordInfo;
  source: NeighborSource;
}

/**
 * Every word plausibly near a label, purely by structural position -- never
 * by guessing which one is semantically correct:
 *  - every OTHER word in the label's own paragraph, both before and after
 *    the label in word-index order (never assumes reading order);
 *  - the immediately preceding paragraph in the same block, if any;
 *  - up to 2 immediately following paragraphs in the same block;
 *  - if the label's paragraph is the block's LAST paragraph, the first
 *    paragraph of the NEXT block;
 *  - if the label's paragraph is the block's FIRST paragraph, the last
 *    paragraph of the PREVIOUS block.
 * The last two exist because Vision's block segmentation does not
 * necessarily align with (or order) a passport's visual field boundaries.
 */
function collectNeighborWords(allWords: readonly WordInfo[], match: LabelMatch): NeighborWord[] {
  const first = match.words[0]!;
  const last = match.words[match.words.length - 1]!;
  const neighbors: NeighborWord[] = [];

  const sameParagraph = allWords.filter(
    (w) =>
      w.pageIndex === first.pageIndex &&
      w.blockIndex === first.blockIndex &&
      w.paragraphIndex === first.paragraphIndex &&
      (w.wordIndex < first.wordIndex || w.wordIndex > last.wordIndex),
  );
  for (const w of sameParagraph) neighbors.push({ word: w, source: 'sameParagraph' });

  const paragraphIndexesInBlock = [
    ...new Set(allWords.filter((w) => w.pageIndex === first.pageIndex && w.blockIndex === first.blockIndex).map((w) => w.paragraphIndex)),
  ].sort((a, b) => a - b);
  const labelParagraphPos = paragraphIndexesInBlock.indexOf(first.paragraphIndex);

  if (labelParagraphPos > 0) {
    const precedingParagraphIndex = paragraphIndexesInBlock[labelParagraphPos - 1]!;
    const words = allWords.filter(
      (w) => w.pageIndex === first.pageIndex && w.blockIndex === first.blockIndex && w.paragraphIndex === precedingParagraphIndex,
    );
    for (const w of words) neighbors.push({ word: w, source: 'precedingParagraphSameBlock' });
  }

  const followingParagraphIndexes = paragraphIndexesInBlock.slice(labelParagraphPos + 1, labelParagraphPos + 3);
  for (const paragraphIndex of followingParagraphIndexes) {
    const words = allWords.filter(
      (w) => w.pageIndex === first.pageIndex && w.blockIndex === first.blockIndex && w.paragraphIndex === paragraphIndex,
    );
    for (const w of words) neighbors.push({ word: w, source: 'followingParagraphSameBlock' });
  }

  if (labelParagraphPos === paragraphIndexesInBlock.length - 1) {
    const nextBlockIndex = first.blockIndex + 1;
    const nextBlockParagraphIndexes = [
      ...new Set(allWords.filter((w) => w.pageIndex === first.pageIndex && w.blockIndex === nextBlockIndex).map((w) => w.paragraphIndex)),
    ].sort((a, b) => a - b);
    const firstParagraphIndex = nextBlockParagraphIndexes[0];
    if (firstParagraphIndex !== undefined) {
      const words = allWords.filter(
        (w) => w.pageIndex === first.pageIndex && w.blockIndex === nextBlockIndex && w.paragraphIndex === firstParagraphIndex,
      );
      for (const w of words) neighbors.push({ word: w, source: 'followingBlockFirstParagraph' });
    }
  }

  if (labelParagraphPos === 0 && first.blockIndex > 0) {
    const prevBlockIndex = first.blockIndex - 1;
    const prevBlockParagraphIndexes = [
      ...new Set(allWords.filter((w) => w.pageIndex === first.pageIndex && w.blockIndex === prevBlockIndex).map((w) => w.paragraphIndex)),
    ].sort((a, b) => a - b);
    const lastParagraphIndex = prevBlockParagraphIndexes[prevBlockParagraphIndexes.length - 1];
    if (lastParagraphIndex !== undefined) {
      const words = allWords.filter(
        (w) => w.pageIndex === first.pageIndex && w.blockIndex === prevBlockIndex && w.paragraphIndex === lastParagraphIndex,
      );
      for (const w of words) neighbors.push({ word: w, source: 'precedingBlockLastParagraph' });
    }
  }

  return neighbors;
}

type RelativePosition = 'LEFT' | 'RIGHT' | 'ABOVE' | 'BELOW' | 'OVERLAP';

/** Pure bounding-box geometry -- never uses word-index/reading order. */
function classifyRelativePosition(labelBox: NormalizedBox, wordBox: NormalizedBox): RelativePosition {
  const verticalOverlap = !(wordBox.y1 < labelBox.y0 || labelBox.y1 < wordBox.y0);
  const horizontalOverlap = !(wordBox.x1 < labelBox.x0 || labelBox.x1 < wordBox.x0);
  if (verticalOverlap && horizontalOverlap) return 'OVERLAP';
  if (verticalOverlap) return wordBox.x0 < labelBox.x0 ? 'LEFT' : 'RIGHT';
  if (horizontalOverlap) return wordBox.y0 < labelBox.y0 ? 'ABOVE' : 'BELOW';
  const labelCenter = boxCenter(labelBox);
  const wordCenter = boxCenter(wordBox);
  const dx = wordCenter.x - labelCenter.x;
  const dy = wordCenter.y - labelCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'LEFT' : 'RIGHT';
  return dy < 0 ? 'ABOVE' : 'BELOW';
}

/** Vision's own iteration order (block, paragraph, wordIndex) -- explicitly NOT assumed to equal visual order; reported separately from relativePosition. */
function compareWordOrder(word: WordInfo, labelFirst: WordInfo): 'BEFORE' | 'AFTER' {
  if (word.blockIndex !== labelFirst.blockIndex) return word.blockIndex < labelFirst.blockIndex ? 'BEFORE' : 'AFTER';
  if (word.paragraphIndex !== labelFirst.paragraphIndex) return word.paragraphIndex < labelFirst.paragraphIndex ? 'BEFORE' : 'AFTER';
  return word.wordIndex < labelFirst.wordIndex ? 'BEFORE' : 'AFTER';
}

interface NeighborAnalysis {
  neighbor: NeighborWord;
  relativePosition: RelativePosition | null;
  visionOrder: 'BEFORE' | 'AFTER';
  horizontalGap: number | null;
  verticalGap: number | null;
  sameRow: boolean;
}

function analyzeNeighbor(labelBox: NormalizedBox, labelFirst: WordInfo, neighbor: NeighborWord): NeighborAnalysis {
  const visionOrder = compareWordOrder(neighbor.word, labelFirst);
  const wordBox = neighbor.word.box;
  if (!wordBox) {
    return { neighbor, relativePosition: null, visionOrder, horizontalGap: null, verticalGap: null, sameRow: false };
  }
  const relativePosition = classifyRelativePosition(labelBox, wordBox);
  const labelCenter = boxCenter(labelBox);
  const wordCenter = boxCenter(wordBox);
  const sameRow = Math.abs(wordCenter.y - labelCenter.y) <= SAME_ROW_Y_TOLERANCE;
  return {
    neighbor,
    relativePosition,
    visionOrder,
    horizontalGap: horizontalGap(labelBox, wordBox),
    verticalGap: verticalGap(labelBox, wordBox),
    sameRow,
  };
}

function formatNeighborLine(a: NeighborAnalysis): string {
  const w = a.neighbor.word;
  const hGap = a.horizontalGap !== null ? a.horizontalGap.toFixed(3) : 'null';
  const vGap = a.verticalGap !== null ? a.verticalGap.toFixed(3) : 'null';
  return (
    `    [${a.neighbor.source}] page=${w.pageIndex} block=${w.blockIndex} paragraph=${w.paragraphIndex} wordIndex=${w.wordIndex} ` +
    `shape=${w.charClass}:${w.rawLength} box=(${formatBox(w.box)}) relativePosition=${a.relativePosition ?? 'UNKNOWN'} ` +
    `visionOrder=${a.visionOrder} hGap=${hGap} vGap=${vGap} sameRow=${a.sameRow}`
  );
}

/** Excludes empty/pure-punctuation words and MRZ-length runs (e.g. a 44-char MIXED token) -- never a semantic guess, only a bounded-shape sanity filter. */
function isPlausibleValueShape(word: WordInfo): boolean {
  if (word.rawLength === 0) return false;
  if (word.rawLength > 20) return false;
  if (word.charClass === 'OTHER') return false;
  return true;
}

type PlaceOfBirthConclusion = 'SAME_ROW' | 'NEXT_ROW' | 'NO_SAFE_CANDIDATE';
type AuthorityConclusion = 'VALUE_LEFT' | 'VALUE_RIGHT' | 'AMBIGUOUS';

function computePlaceOfBirthConclusion(analyses: readonly NeighborAnalysis[]): PlaceOfBirthConclusion {
  const sameRowRight = analyses.some((a) => a.relativePosition === 'RIGHT' && a.sameRow && isPlausibleValueShape(a.neighbor.word));
  if (sameRowRight) return 'SAME_ROW';
  const below = analyses.some((a) => a.relativePosition === 'BELOW' && isPlausibleValueShape(a.neighbor.word));
  if (below) return 'NEXT_ROW';
  return 'NO_SAFE_CANDIDATE';
}

function computeAuthorityConclusion(analyses: readonly NeighborAnalysis[]): AuthorityConclusion {
  const left = analyses.some((a) => a.relativePosition === 'LEFT' && a.sameRow && isPlausibleValueShape(a.neighbor.word));
  const right = analyses.some((a) => a.relativePosition === 'RIGHT' && a.sameRow && isPlausibleValueShape(a.neighbor.word));
  if (left && !right) return 'VALUE_LEFT';
  if (right && !left) return 'VALUE_RIGHT';
  return 'AMBIGUOUS';
}

function fieldBucketForLabel(canonicalLabel: string): 'placeOfBirth' | 'authority' {
  return canonicalLabel === 'AUTHORITY' || canonicalLabel === 'ISSUING AUTHORITY' || canonicalLabel === 'ISSUED BY' ? 'authority' : 'placeOfBirth';
}

function formatLabelMatchReport(
  allWords: readonly WordInfo[],
  match: LabelMatch,
): { report: string; bucket: 'placeOfBirth' | 'authority'; placeOfBirthConclusion?: PlaceOfBirthConclusion; authorityConclusion?: AuthorityConclusion } {
  const first = match.words[0]!;
  const last = match.words[match.words.length - 1]!;
  const labelBoxes = match.words.map((w) => w.box).filter((b): b is NormalizedBox => b !== null);
  const labelBox =
    labelBoxes.length > 0
      ? {
          x0: Math.min(...labelBoxes.map((b) => b.x0)),
          y0: Math.min(...labelBoxes.map((b) => b.y0)),
          x1: Math.max(...labelBoxes.map((b) => b.x1)),
          y1: Math.max(...labelBoxes.map((b) => b.y1)),
        }
      : null;
  const bucket = fieldBucketForLabel(match.canonicalLabel);

  const lines: string[] = [];
  lines.push(`LABEL MATCH: canonical="${match.canonicalLabel}" matchedForm="${match.matchedForm}" windowWordCount=${match.windowWordCount}`);
  lines.push(`  location: page=${first.pageIndex} block=${first.blockIndex} paragraph=${first.paragraphIndex} wordIndex=${first.wordIndex}..${last.wordIndex}`);
  lines.push(`  labelBox: ${formatBox(labelBox)}`);

  if (!labelBox) {
    lines.push('  (label has no bounding-box data -- cannot analyze neighbors)');
    return { report: lines.join('\n'), bucket };
  }

  const neighbors = collectNeighborWords(allWords, match);
  if (neighbors.length === 0) {
    lines.push('  (no neighbor words found in same paragraph, adjacent paragraphs, or adjacent block boundary)');
    return { report: lines.join('\n'), bucket };
  }

  const analyses = neighbors.map((n) => analyzeNeighbor(labelBox, first, n));
  lines.push(`  neighbors (${analyses.length}):`);
  for (const a of analyses) lines.push(formatNeighborLine(a));

  if (bucket === 'placeOfBirth') {
    const conclusion = computePlaceOfBirthConclusion(analyses);
    lines.push(`  FIELD CONCLUSION (placeOfBirth): ${conclusion}`);
    return { report: lines.join('\n'), bucket, placeOfBirthConclusion: conclusion };
  } else {
    const conclusion = computeAuthorityConclusion(analyses);
    lines.push(`  FIELD CONCLUSION (authority): ${conclusion}`);
    return { report: lines.join('\n'), bucket, authorityConclusion: conclusion };
  }
}

let realVisionClient: ImageAnnotatorClient | null = null;
function getRealVisionClient(): ImageAnnotatorClient {
  if (!realVisionClient) {
    realVisionClient = new ImageAnnotatorClient();
  }
  return realVisionClient;
}

async function detectTextAnnotation(imageBuffer: Buffer): Promise<protos.google.cloud.vision.v1.ITextAnnotation | null | undefined> {
  const client = getRealVisionClient();
  const [response]: [protos.google.cloud.vision.v1.IAnnotateImageResponse] = await client.documentTextDetection(imageBuffer);
  if (response.error?.message) {
    throw new Error(response.error.message);
  }
  return response.fullTextAnnotation;
}

interface MessageSummary {
  placeOfBirth: PlaceOfBirthConclusion | 'NOT_FOUND';
  authority: AuthorityConclusion | 'NOT_FOUND';
}

async function runForTelegramMessageNumber(telegramMessageNum: string): Promise<MessageSummary> {
  console.log(`\n[place-authority-labels] ===== telegram_message_num=${telegramMessageNum} =====`);
  const summary: MessageSummary = { placeOfBirth: 'NOT_FOUND', authority: 'NOT_FOUND' };

  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    `SELECT telegram_photo_file_id FROM telegram_messages WHERE telegram_message_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [telegramMessageNum],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.log('[place-authority-labels] no telegram_messages row found for this number');
    return summary;
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);

  let textAnnotation: protos.google.cloud.vision.v1.ITextAnnotation | null | undefined;
  try {
    textAnnotation = await detectTextAnnotation(buffer);
  } catch {
    console.log('[place-authority-labels] visionSuccess=false (Vision API call failed)');
    return summary;
  }

  const pages = textAnnotation?.pages;
  if (!pages || pages.length === 0) {
    console.log('[place-authority-labels] visionSuccess=true pageCount=0 (no structural data returned)');
    return summary;
  }
  console.log(`[place-authority-labels] visionSuccess=true pageCount=${pages.length}`);

  const words = flattenWords(pages as VisionPage[]);
  console.log(`[place-authority-labels] totalWordCount=${words.length}`);

  const rawMatches = findLabelMatches(words);
  const matches = dedupeMatches(rawMatches);
  if (matches.length === 0) {
    console.log(
      '[place-authority-labels] RESULT: label not found -- none of PLACE OF BIRTH / BIRTH PLACE / BIRTHPLACE / ' +
        'AUTHORITY / ISSUING AUTHORITY / ISSUED BY matched anywhere on this page (never guessed).',
    );
    return summary;
  }

  console.log(`[place-authority-labels] RESULT: ${matches.length} distinct label location(s) found (${rawMatches.length} raw window matches before dedupe)`);
  for (const match of matches) {
    const { report, bucket, placeOfBirthConclusion, authorityConclusion } = formatLabelMatchReport(words, match);
    console.log(report);
    if (bucket === 'placeOfBirth' && placeOfBirthConclusion) summary.placeOfBirth = placeOfBirthConclusion;
    if (bucket === 'authority' && authorityConclusion) summary.authority = authorityConclusion;
  }

  return summary;
}

/**
 * Read-only auto-selection of real sample messages: the most recently
 * ingested Telegram messages whose passport_processing run actually
 * completed successfully (status='completed') -- the strongest available
 * signal that the photo really is a legible passport, not an arbitrary
 * chat image. SELECT only, no writes. Capped by MAX_AUTO_COUNT regardless
 * of what count is requested.
 */
async function selectAutoMessageNums(requestedCount: number): Promise<string[]> {
  const count = Math.max(1, Math.min(requestedCount, MAX_AUTO_COUNT));
  const { rows } = await pool.query<{ telegram_message_id: string }>(
    `SELECT tm.telegram_message_id::text AS telegram_message_id
     FROM telegram_messages tm
     JOIN passport_processing pp ON pp.telegram_message_id = tm.id
     WHERE pp.status = 'completed'
     ORDER BY tm.created_at DESC
     LIMIT $1`,
    [count],
  );
  return rows.map((r) => r.telegram_message_id);
}

interface ParsedArgs {
  messageNums: string[] | null;
  autoCount: number | null;
  error: string | null;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) {
    return { messageNums: null, autoCount: null, error: 'no arguments given' };
  }
  if (argv[0] === '--auto') {
    const countArg = argv[1];
    const count = countArg ? Number.parseInt(countArg, 10) : NaN;
    if (!Number.isFinite(count) || count <= 0) {
      return { messageNums: null, autoCount: null, error: '--auto requires a positive integer count' };
    }
    return { messageNums: null, autoCount: count, error: null };
  }
  const invalid = argv.filter((num) => !/^\d+$/.test(num));
  if (invalid.length > 0) {
    return { messageNums: null, autoCount: null, error: `expected numeric telegram message ids, got: ${invalid.join(', ')}` };
  }
  return { messageNums: [...argv], autoCount: null, error: null };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`${parsed.error}`);
    console.error('Usage: tsx scripts/tmp-diagnostic-google-vision-place-authority-labels.ts <messageNum> [...]');
    console.error(`   or: tsx scripts/tmp-diagnostic-google-vision-place-authority-labels.ts --auto <count>  (max ${MAX_AUTO_COUNT})`);
    process.exitCode = 1;
    return;
  }

  const results = new Map<string, MessageSummary>();
  try {
    let messageNums: string[];
    if (parsed.autoCount !== null) {
      messageNums = await selectAutoMessageNums(parsed.autoCount);
      console.log(`[place-authority-labels] auto-selected ${messageNums.length} real, successfully-processed message(s) (requested ${parsed.autoCount}, capped at ${MAX_AUTO_COUNT})`);
      if (messageNums.length === 0) {
        console.log('[place-authority-labels] no completed passport_processing messages found -- nothing to analyze');
      }
    } else {
      messageNums = parsed.messageNums!;
    }

    for (const num of messageNums) {
      const summary = await runForTelegramMessageNumber(num);
      results.set(num, summary);
    }

    console.log('\n[place-authority-labels] ===== PER-MESSAGE STRUCTURAL SUMMARY (geometry/shape only, never semantic guessing) =====');
    let line = 1;
    for (const [messageNum, summary] of results) {
      console.log(`${line}. PLACE_OF_BIRTH_${messageNum}: ${summary.placeOfBirth}`);
      line++;
    }
    for (const [messageNum, summary] of results) {
      console.log(`${line}. AUTHORITY_${messageNum}: ${summary.authority}`);
      line++;
    }

    const placeOfBirthCounts: Record<PlaceOfBirthConclusion | 'NOT_FOUND', number> = {
      SAME_ROW: 0,
      NEXT_ROW: 0,
      NO_SAFE_CANDIDATE: 0,
      NOT_FOUND: 0,
    };
    const authorityCounts: Record<AuthorityConclusion | 'NOT_FOUND', number> = {
      VALUE_LEFT: 0,
      VALUE_RIGHT: 0,
      AMBIGUOUS: 0,
      NOT_FOUND: 0,
    };
    for (const summary of results.values()) {
      placeOfBirthCounts[summary.placeOfBirth] += 1;
      authorityCounts[summary.authority] += 1;
    }

    console.log('\n[place-authority-labels] ===== AGGREGATE COUNTS =====');
    console.log(`totalMessagesProcessed=${results.size}`);
    console.log(
      `PLACE_OF_BIRTH: SAME_ROW=${placeOfBirthCounts.SAME_ROW} NEXT_ROW=${placeOfBirthCounts.NEXT_ROW} ` +
        `NO_SAFE_CANDIDATE=${placeOfBirthCounts.NO_SAFE_CANDIDATE} NOT_FOUND=${placeOfBirthCounts.NOT_FOUND}`,
    );
    console.log(
      `AUTHORITY: VALUE_LEFT=${authorityCounts.VALUE_LEFT} VALUE_RIGHT=${authorityCounts.VALUE_RIGHT} ` +
        `AMBIGUOUS=${authorityCounts.AMBIGUOUS} NOT_FOUND=${authorityCounts.NOT_FOUND}`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-google-vision-place-authority-labels.ts')) {
  main().catch((error) => {
    console.error('[place-authority-labels] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
