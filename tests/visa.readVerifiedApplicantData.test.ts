import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readVerifiedApplicantData,
  type ReadVerifiedApplicantDataDependencies,
  type VisaSheetReadClient,
} from '../src/visa/readVerifiedApplicantData.js';
import type { Group } from '../src/db/repositories/groups.repo.js';
import type { PassportMessageLinkRecord } from '../src/db/repositories/passportMessageLinks.repo.js';

/**
 * Entirely local unit tests for readVerifiedApplicantData.ts -- no DB, no
 * Google Sheets API, no network. Every dependency (findActiveCanonicalLink,
 * findGroup, ensureSheet, readClient, resolveSheetTitle) is faked, but the
 * REAL readVerifiedApplicantData function is always the one under test --
 * unlike every existing caller's own test file (visitSaudiPreflight.test.ts,
 * visaAssignCommand.test.ts), which both fake this function away entirely.
 *
 * Column layout matches visaSheetColumns.ts's own VISA_COLUMN_INDEX exactly
 * (confirmed by reading that file directly, read-only, before writing this
 * test): A=0 (unused here), firstName=1, surname=2, passportNumber=3,
 * dateOfBirth=4, passportIssueDate=5, passportExpiryDate=6, gender=7,
 * H..L=8..11 (unused), M=12 (technical id, matched against
 * activeCanonical.telegramMessageId), N=13/O=14/P=15 (gender-summary block,
 * unused here), nationality=16 (Q), email=17 (R), arrivalDate=18 (S),
 * personalPhotoUrl=19 (T), passportScanUrl=20 (U), personalPortraitUrl=21 (V).
 */

const TECHNICAL_ID_INDEX = 12;

interface RowOverrides {
  technicalId?: string;
  firstName?: string;
  personalPhotoUrl?: string;
  passportScanUrl?: string;
  personalPortraitUrl?: string;
}

/** Builds one full A:V row (22 cells), with sensible placeholder values everywhere not explicitly overridden, so a test only has to name what it actually cares about. */
function buildRow(overrides: RowOverrides = {}): string[] {
  const row = new Array(22).fill('');
  row[1] = overrides.firstName ?? 'FIRSTNAME';
  row[2] = 'SURNAME';
  row[3] = 'AB1234567';
  row[4] = '1990-01-01';
  row[5] = '2020-01-01';
  row[6] = '2030-01-01';
  row[7] = 'Erkak';
  row[TECHNICAL_ID_INDEX] = overrides.technicalId ?? 'message-1';
  row[16] = 'UZB';
  row[17] = 'test@example.com';
  row[18] = '2026-10-05';
  row[19] = overrides.personalPhotoUrl ?? '';
  row[20] = overrides.passportScanUrl ?? '';
  row[21] = overrides.personalPortraitUrl ?? '';
  return row;
}

function fakeLink(telegramMessageId: string): PassportMessageLinkRecord {
  return {
    id: 'fake-link-1',
    passportIdentityId: 'identity-1',
    telegramMessageId,
    groupId: 'group-1',
    agentId: null,
    role: 'canonical',
    linkStatus: 'active',
    matchConfidenceTier: 'new_identity',
    resolvedBy: 'auto',
    createdAt: new Date().toISOString(),
  };
}

function fakeGroup(): Group {
  return {
    id: 'group-1',
    name: 'Test Group',
    departureDate: '2026-10-05',
    telegramChatId: null,
    googleSheetId: null,
    googleSheetGid: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

interface BuildDepsOptions {
  link?: PassportMessageLinkRecord | null;
  group?: Group | null;
  rows?: string[][];
}

interface DepsCallCounts {
  findActiveCanonicalLink: number;
  findGroup: number;
  ensureSheet: number;
  getAllDataRows: number;
  resolveSheetTitle: number;
}

function buildDeps(options: BuildDepsOptions): { deps: ReadVerifiedApplicantDataDependencies; calls: DepsCallCounts } {
  const calls: DepsCallCounts = {
    findActiveCanonicalLink: 0,
    findGroup: 0,
    ensureSheet: 0,
    getAllDataRows: 0,
    resolveSheetTitle: 0,
  };

  const readClient: VisaSheetReadClient = {
    async getAllDataRows() {
      calls.getAllDataRows += 1;
      return options.rows ?? [];
    },
  };

  const deps: ReadVerifiedApplicantDataDependencies = {
    findActiveCanonicalLink: async () => {
      calls.findActiveCanonicalLink += 1;
      return options.link !== undefined ? options.link : fakeLink('message-1');
    },
    findGroup: async () => {
      calls.findGroup += 1;
      return options.group !== undefined ? options.group : fakeGroup();
    },
    ensureSheet: async () => {
      calls.ensureSheet += 1;
      return { spreadsheetId: 'sheet-abc' };
    },
    readClient,
    resolveSheetTitle: async () => {
      calls.resolveSheetTitle += 1;
      throw new Error('resolveSheetTitle should not be called when googleSheetGid is null (every fixture here uses null)');
    },
  };

  return { deps, calls };
}

test('reads the portrait URL correctly from column V (index 21)', async () => {
  const row = buildRow({ personalPortraitUrl: 'https://example.com/portrait.jpg' });
  const { deps } = buildDeps({ rows: [row] });

  const result = await readVerifiedApplicantData('group-1', 'identity-1', deps);

  assert.ok(result);
  assert.equal(result.personalPortraitUrl, 'https://example.com/portrait.jpg');
});

test('portrait URL blank -> result.personalPortraitUrl is an empty string, never null/undefined', async () => {
  const row = buildRow({ personalPortraitUrl: '' });
  const { deps } = buildDeps({ rows: [row] });

  const result = await readVerifiedApplicantData('group-1', 'identity-1', deps);

  assert.ok(result);
  assert.equal(result.personalPortraitUrl, '');
});

test('a full personalPhotoUrl present but no portrait -> personalPortraitUrl is NOT replaced by the full photo URL', async () => {
  const row = buildRow({
    personalPhotoUrl: 'https://example.com/full-photo.jpg',
    personalPortraitUrl: '',
  });
  const { deps } = buildDeps({ rows: [row] });

  const result = await readVerifiedApplicantData('group-1', 'identity-1', deps);

  assert.ok(result);
  assert.equal(result.personalPortraitUrl, '', 'must stay blank, never fall back to personalPhotoUrl');
  assert.equal(result.personalPhotoUrl, 'https://example.com/full-photo.jpg', 'personalPhotoUrl itself is still read correctly');
  assert.notEqual(result.personalPortraitUrl, result.personalPhotoUrl);
});

test('personalPhotoUrl and passportScanUrl are read from their own columns (T and U), never swapped', async () => {
  const row = buildRow({
    personalPhotoUrl: 'https://example.com/photo.jpg',
    passportScanUrl: 'https://example.com/scan.jpg',
    personalPortraitUrl: 'https://example.com/portrait.jpg',
  });
  const { deps } = buildDeps({ rows: [row] });

  const result = await readVerifiedApplicantData('group-1', 'identity-1', deps);

  assert.ok(result);
  assert.equal(result.personalPhotoUrl, 'https://example.com/photo.jpg');
  assert.equal(result.passportScanUrl, 'https://example.com/scan.jpg');
  assert.equal(result.personalPortraitUrl, 'https://example.com/portrait.jpg');
  // All three distinct -- proves none of the three columns is accidentally aliased to another.
  const values = [result.personalPhotoUrl, result.passportScanUrl, result.personalPortraitUrl];
  assert.equal(new Set(values).size, 3);
});

test('selects the row matching the active canonical link\'s telegramMessageId (column M) -- a non-matching row is never used', async () => {
  const wrongRow = buildRow({ technicalId: 'message-WRONG', firstName: 'WRONG_PERSON', personalPortraitUrl: 'https://example.com/wrong-portrait.jpg' });
  const rightRow = buildRow({ technicalId: 'message-RIGHT', firstName: 'RIGHT_PERSON', personalPortraitUrl: 'https://example.com/right-portrait.jpg' });
  const { deps } = buildDeps({
    link: fakeLink('message-RIGHT'),
    rows: [wrongRow, rightRow],
  });

  const result = await readVerifiedApplicantData('group-1', 'identity-1', deps);

  assert.ok(result);
  assert.equal(result.firstName, 'RIGHT_PERSON');
  assert.equal(result.personalPortraitUrl, 'https://example.com/right-portrait.jpg');
});

test('no active canonical link -> returns null, and the Sheet is never read at all', async () => {
  const { deps, calls } = buildDeps({ link: null, rows: [buildRow()] });

  const result = await readVerifiedApplicantData('group-1', 'identity-1', deps);

  assert.equal(result, null);
  assert.equal(calls.findActiveCanonicalLink, 1);
  assert.equal(calls.findGroup, 0, 'findGroup must never be called once there is no active canonical link');
  assert.equal(calls.ensureSheet, 0, 'ensureSheet (which would reach the Google Sheets API) must never be called');
  assert.equal(calls.getAllDataRows, 0, 'the Sheet itself must never be read');
});
