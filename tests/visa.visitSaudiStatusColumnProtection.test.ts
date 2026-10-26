import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ensureVisaStatusColumnProtected,
  VISA_STATUS_PROTECTION_DESCRIPTION,
  type ExistingProtectedRange,
  type SheetGridRange,
  type VisaStatusColumnProtectionClient,
} from '../src/visa/visitSaudiStatusColumnProtection.js';

const SPREADSHEET_ID = 'sheet-1';
const RANGE: SheetGridRange = { sheetId: 0, startColumnIndex: 22, endColumnIndex: 23 }; // proposed column W

test('creates a new protected range when none exists yet', async () => {
  const addCalls: Array<{ range: SheetGridRange; description: string }> = [];
  const client: VisaStatusColumnProtectionClient = {
    listProtectedRanges: async () => [],
    addProtectedRange: async (_spreadsheetId, range, description) => {
      addCalls.push({ range, description });
      return { protectedRangeId: 123, range, description };
    },
  };

  const result = await ensureVisaStatusColumnProtected(SPREADSHEET_ID, RANGE, client);

  assert.deepEqual(result, { ok: true, outcome: 'newly-protected', protectedRangeId: 123 });
  assert.equal(addCalls.length, 1);
  assert.equal(addCalls[0]!.description, VISA_STATUS_PROTECTION_DESCRIPTION);
  assert.deepEqual(addCalls[0]!.range, RANGE);
});

test('does NOT create a duplicate protection when one already exists for this exact column', async () => {
  const existing: ExistingProtectedRange = { protectedRangeId: 42, range: RANGE, description: VISA_STATUS_PROTECTION_DESCRIPTION };
  let addCalled = false;
  const client: VisaStatusColumnProtectionClient = {
    listProtectedRanges: async () => [existing],
    addProtectedRange: async (_spreadsheetId, range, description) => {
      addCalled = true;
      return { protectedRangeId: 999, range, description };
    },
  };

  const result = await ensureVisaStatusColumnProtected(SPREADSHEET_ID, RANGE, client);

  assert.deepEqual(result, { ok: true, outcome: 'already-protected', protectedRangeId: 42 });
  assert.equal(addCalled, false);
});

test('calling it twice in a row never accumulates a second protection (idempotent)', async () => {
  let protections: ExistingProtectedRange[] = [];
  const client: VisaStatusColumnProtectionClient = {
    listProtectedRanges: async () => protections,
    addProtectedRange: async (_spreadsheetId, range, description) => {
      const created: ExistingProtectedRange = { protectedRangeId: protections.length + 1, range, description };
      protections = [...protections, created];
      return created;
    },
  };

  const first = await ensureVisaStatusColumnProtected(SPREADSHEET_ID, RANGE, client);
  const second = await ensureVisaStatusColumnProtected(SPREADSHEET_ID, RANGE, client);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok) assert.equal(first.outcome, 'newly-protected');
  if (second.ok) assert.equal(second.outcome, 'already-protected');
  assert.equal(protections.length, 1); // never grew to 2
});

test('an existing protection on a DIFFERENT column/description is not mistaken for this one -- still creates the right one', async () => {
  const unrelated: ExistingProtectedRange = {
    protectedRangeId: 7,
    range: { sheetId: 0, startColumnIndex: 0, endColumnIndex: 1 }, // column A, some other protection
    description: 'some unrelated protection',
  };
  const addCalls: SheetGridRange[] = [];
  const client: VisaStatusColumnProtectionClient = {
    listProtectedRanges: async () => [unrelated],
    addProtectedRange: async (_spreadsheetId, range) => {
      addCalls.push(range);
      return { protectedRangeId: 55, range, description: VISA_STATUS_PROTECTION_DESCRIPTION };
    },
  };

  const result = await ensureVisaStatusColumnProtected(SPREADSHEET_ID, RANGE, client);

  assert.deepEqual(result, { ok: true, outcome: 'newly-protected', protectedRangeId: 55 });
  assert.equal(addCalls.length, 1);
});

test('a Sheets API failure while listing existing protections is surfaced, never hidden', async () => {
  const client: VisaStatusColumnProtectionClient = {
    listProtectedRanges: async () => {
      throw new Error('simulated Sheets API failure (list)');
    },
    addProtectedRange: async (_s, range, description) => ({ protectedRangeId: 1, range, description }),
  };

  const result = await ensureVisaStatusColumnProtected(SPREADSHEET_ID, RANGE, client);

  assert.deepEqual(result, { ok: false, reason: 'SHEETS_API_ERROR', detail: 'simulated Sheets API failure (list)' });
});

test('a Sheets API failure while creating the protection is surfaced, never hidden', async () => {
  const client: VisaStatusColumnProtectionClient = {
    listProtectedRanges: async () => [],
    addProtectedRange: async () => {
      throw new Error('simulated Sheets API failure (add)');
    },
  };

  const result = await ensureVisaStatusColumnProtected(SPREADSHEET_ID, RANGE, client);

  assert.deepEqual(result, { ok: false, reason: 'SHEETS_API_ERROR', detail: 'simulated Sheets API failure (add)' });
});
