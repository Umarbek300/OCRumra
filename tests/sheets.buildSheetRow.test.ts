import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSheetRow, SHEET_ROW_COLUMN_COUNT, type BuildSheetRowInput } from '../src/sheets/buildSheetRow.js';

function ocrResult(overrides: Partial<BuildSheetRowInput['ocrResult']> = {}): BuildSheetRowInput['ocrResult'] {
  return {
    firstName: { value: 'ANNA', confidence: 'high' },
    surname: { value: 'ERIKSSON', confidence: 'high' },
    passportNumber: { value: 'L898902C3', confidence: 'high' },
    dateOfBirth: { value: '1974-08-12', confidence: 'high' },
    passportIssueDate: { value: '2004-01-01', confidence: 'medium' },
    passportExpiryDate: { value: '2012-04-15', confidence: 'high' },
    gender: { value: 'female', confidence: 'high' },
    ...overrides,
  };
}

test('buildSheetRow returns exactly the 12 approved columns in order', () => {
  const row = buildSheetRow({ ocrResult: ocrResult(), agent: { name: 'Jasur Agent' } });

  assert.equal(row.length, SHEET_ROW_COLUMN_COUNT);
  assert.deepEqual(row, [
    '', // №
    'ANNA',
    'ERIKSSON',
    'L898902C3',
    '1974-08-12',
    '2004-01-01',
    '2012-04-15',
    'Ayol',
    'Jasur Agent',
    '', // Paket
    '', // Depozit
    '', // Qoldiq
  ]);
});

test('buildSheetRow leaves № empty — never a stable backend-assigned id', () => {
  const row = buildSheetRow({ ocrResult: ocrResult(), agent: { name: 'Jasur Agent' } });
  assert.equal(row[0], '');
});

test('buildSheetRow maps gender to an Uzbek label', () => {
  const male = buildSheetRow({ ocrResult: ocrResult({ gender: { value: 'male', confidence: 'high' } }), agent: null });
  const female = buildSheetRow({ ocrResult: ocrResult({ gender: { value: 'female', confidence: 'high' } }), agent: null });
  assert.equal(male[7], 'Erkak');
  assert.equal(female[7], 'Ayol');
});

test('buildSheetRow renders gender as empty for unspecified or missing value, never a placeholder word', () => {
  const unspecified = buildSheetRow({ ocrResult: ocrResult({ gender: { value: 'unspecified', confidence: 'low' } }), agent: null });
  const missing = buildSheetRow({ ocrResult: ocrResult({ gender: { value: null, confidence: null } }), agent: null });
  assert.equal(unspecified[7], '');
  assert.equal(missing[7], '');
});

test('buildSheetRow leaves passportIssueDate empty (not "N/A") when Vision could not find it', () => {
  const row = buildSheetRow({ ocrResult: ocrResult({ passportIssueDate: { value: null, confidence: null } }), agent: null });
  assert.equal(row[5], '');
  assert.notEqual(row[5], 'N/A');
});

test('buildSheetRow renders every missing OCR field as empty string, never null/undefined/"null"', () => {
  const row = buildSheetRow({
    ocrResult: ocrResult({
      firstName: { value: null, confidence: null },
      surname: { value: null, confidence: null },
      passportNumber: { value: null, confidence: null },
      dateOfBirth: { value: null, confidence: null },
      passportIssueDate: { value: null, confidence: null },
      passportExpiryDate: { value: null, confidence: null },
    }),
    agent: null,
  });

  for (const cell of row) {
    assert.notEqual(cell, null);
    assert.notEqual(cell, undefined);
    assert.notEqual(cell, 'null');
  }
});

test('buildSheetRow leaves the Agent column empty when no agent is linked', () => {
  const row = buildSheetRow({ ocrResult: ocrResult(), agent: null });
  assert.equal(row[8], '');
});

test('buildSheetRow always leaves Paket, Depozit, Qoldiq empty — operator-entered, never written by this pipeline', () => {
  const row = buildSheetRow({ ocrResult: ocrResult(), agent: { name: 'Jasur Agent' } });
  assert.equal(row[9], '');
  assert.equal(row[10], '');
  assert.equal(row[11], '');
});

test('buildSheetRow input shape has no placeOfBirth or printed issuingAuthority field at all', () => {
  // Structural guarantee, not just a blanked value: BuildSheetRowInput['ocrResult']
  // is a Pick<> that does not include placeOfBirth or issuingAuthority, so
  // there is no way to accidentally pass or surface either through this function.
  const row = buildSheetRow({ ocrResult: ocrResult(), agent: { name: 'Jasur Agent' } });
  assert.equal(row.length, SHEET_ROW_COLUMN_COUNT);
});
