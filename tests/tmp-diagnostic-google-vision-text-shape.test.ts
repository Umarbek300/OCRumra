import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  summarizeFullTextShape,
  formatFullTextShapeSummary,
} from '../scripts/tmp-diagnostic-google-vision-text-shape.js';

test('summarizeFullTextShape reports fullTextLength and newlineCount', () => {
  const fullText = 'HEADER\nBODY LINE\nFOOTER';
  const summary = summarizeFullTextShape(fullText);

  assert.strictEqual(summary.fullTextLength, fullText.length);
  assert.strictEqual(summary.newlineCount, 2);
  assert.strictEqual(summary.lines.length, 3);
});

test('summarizeFullTextShape rejects a line with no filler character even if length-shaped correctly', () => {
  const line = 'A'.repeat(44); // 44 chars, right length, no "<"
  const summary = summarizeFullTextShape(line);

  assert.strictEqual(summary.lines[0]!.rejectReason, 'no-filler-char');
  assert.strictEqual(summary.lines[0]!.hasFillerChar, false);
  assert.strictEqual(summary.lines[0]!.withinLengthWindow, true);
});

test('summarizeFullTextShape rejects a line that is too short even though it contains a filler char', () => {
  const line = 'AB<CD'; // 5 chars, far under the 30-50 window
  const summary = summarizeFullTextShape(line);

  assert.match(summary.lines[0]!.rejectReason ?? '', /length-out-of-window/);
});

test('summarizeFullTextShape marks a line with no rejection when it is MRZ-window-shaped with a filler char', () => {
  const line = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<'; // 44 chars, valid MRZ shape
  const summary = summarizeFullTextShape(line);

  assert.strictEqual(summary.lines[0]!.rejectReason, null);
  assert.strictEqual(summary.lines[0]!.hasFillerChar, true);
  assert.strictEqual(summary.lines[0]!.matchesMrzAlphabet, true);
});

test('summarizeFullTextShape simulates Vision fragmenting an MRZ line into many short word-lines, all rejected by length', () => {
  // If Vision's line segmentation breaks the MRZ line into separate
  // "words" instead of one continuous line, each fragment individually
  // fails the length window even though the concatenated text would be
  // MRZ-shaped — this is exactly the hypothesis this script exists to
  // check for real Vision output.
  const fullText = ['P<UTOERIKSSON', '<<ANNA<MARIA', '<<<<<<<<<<<<<<<<<<<'].join('\n');
  const summary = summarizeFullTextShape(fullText);

  assert.ok(summary.lines.every((l) => l.rejectReason !== null));
  assert.ok(summary.lines.some((l) => /length-out-of-window/.test(l.rejectReason ?? '')));
});

test('summarizeFullTextShape treats an empty line as empty-after-cleaning', () => {
  const summary = summarizeFullTextShape('');
  assert.strictEqual(summary.lines[0]!.rejectReason, 'empty-after-cleaning');
});

test('summarizeFullTextShape treats a whitespace-only line as empty-after-cleaning', () => {
  const summary = summarizeFullTextShape('   \t  ');
  assert.strictEqual(summary.lines[0]!.rejectReason, 'empty-after-cleaning');
});

test('formatFullTextShapeSummary never includes raw line content, only labeled counts and booleans', () => {
  const fullText = 'REPUBLIC OF UTOPIA\nP<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';
  const summary = summarizeFullTextShape(fullText);
  const formatted = formatFullTextShapeSummary(summary);

  assert.ok(!formatted.includes('REPUBLIC OF UTOPIA'));
  assert.ok(!formatted.includes('ERIKSSON'));
  assert.ok(!formatted.includes('P<UTOERIKSSON'));
  assert.ok(formatted.includes('fullTextLength='));
  assert.ok(formatted.includes('newlineCount='));
  assert.ok(formatted.includes('rejectReason='));
});
