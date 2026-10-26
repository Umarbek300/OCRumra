import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIRST_DATA_ROW_NUMBER } from '../src/sheets/sheetLayout.js';
import type { Group } from '../src/db/repositories/groups.repo.js';
import type { PassportMessageLinkRecord } from '../src/db/repositories/passportMessageLinks.repo.js';
import type { VerifiedApplicantData } from '../src/visa/types.js';
import { validateVerifiedApplicantData } from '../src/visa/validateVerifiedApplicantData.js';
import { buildVisaApplicationDraft } from '../src/visa/buildVisaApplicationDraft.js';
import { computeVisitSaudiTripDates } from '../src/visa/computeVisitSaudiTripDates.js';
import { computeMaritalStatusForVisitSaudi } from '../src/visa/computeMaritalStatusForVisitSaudi.js';
import { lookupCountryCapital } from '../src/visa/countryCapitalLookup.js';
import { mapGenderToProfessionForVisitSaudi } from '../src/visa/genderProfessionMap.js';
import {
  checkVisitSaudiApplicantPreflight,
  checkVisitSaudiGroupPreflight,
  type VisitSaudiPreflightDependencies,
} from '../src/visa/visitSaudiPreflight.js';

const GROUP_ID = 'group-1';
const PASSPORT_IDENTITY_ID = 'identity-1';

const mockGroup: Group = {
  id: GROUP_ID,
  name: '26 October 2026',
  departureDate: '2026-10-26',
  telegramChatId: '-1001234567890',
  googleSheetId: 'sheet-1',
  googleSheetGid: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const mockLink: PassportMessageLinkRecord = {
  id: 'link-1',
  passportIdentityId: PASSPORT_IDENTITY_ID,
  telegramMessageId: 'msg-1',
  groupId: GROUP_ID,
  agentId: null,
  role: 'canonical',
  linkStatus: 'active',
  matchConfidenceTier: 'high',
  resolvedBy: 'auto',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const validData: VerifiedApplicantData = {
  firstName: 'Ali',
  surname: 'Valiyev',
  passportNumber: 'AB1234567',
  dateOfBirth: '2000-05-10',
  passportIssueDate: '2020-01-01',
  passportExpiryDate: '2030-01-01',
  gender: 'Erkak',
  nationality: 'UZBEKISTAN',
  email: 'ali@example.com',
  // Deliberately a DIFFERENT date from groups.departureDate (2026-10-26) --
  // this is Sheet column S, the pre-existing, unrelated "Kirish sanasi"
  // field. Expected Date of Arrival must come out as 2026-10-26, never
  // this value, proving the two never get confused.
  arrivalDate: '2026-10-01',
  personalPhotoUrl: 'https://example.com/photo.jpg',
  personalPortraitUrl: 'https://example.com/portrait.jpg',
  passportScanUrl: 'https://example.com/scan.jpg',
};

function buildRow(telegramMessageIdAtColumnM: string | null): string[] {
  const row = new Array(22).fill('');
  if (telegramMessageIdAtColumnM !== null) {
    row[12] = telegramMessageIdAtColumnM;
  }
  return row;
}

interface DepsOverrides {
  group?: Group | null;
  link?: PassportMessageLinkRecord | null;
  data?: VerifiedApplicantData | null;
  rows?: string[][];
}

function buildDeps(overrides: DepsOverrides = {}): VisitSaudiPreflightDependencies {
  const group = overrides.group === undefined ? mockGroup : overrides.group;
  const link = overrides.link === undefined ? mockLink : overrides.link;
  const data = overrides.data === undefined ? validData : overrides.data;
  const rows = overrides.rows ?? [buildRow('other-1'), buildRow('other-2'), buildRow('other-3'), buildRow('msg-1')];

  return {
    findGroup: async () => group,
    findActiveCanonicalLink: async () => link,
    findActiveCanonicalLinksForGroup: async () => (link ? [link] : []),
    readVerifiedApplicantData: async () => data,
    validate: validateVerifiedApplicantData,
    buildDraft: buildVisaApplicationDraft,
    computeTripDates: computeVisitSaudiTripDates,
    computeMaritalStatus: computeMaritalStatusForVisitSaudi,
    lookupCountryCapital,
    mapGenderToProfession: mapGenderToProfessionForVisitSaudi,
    ensureSheet: async () => ({ spreadsheetId: 'sheet-1' }),
    resolveSheetTitle: async () => {
      throw new Error('resolveSheetTitle should not be called when googleSheetGid is null');
    },
    readClient: { getAllDataRows: async () => rows },
  };
}

test('happy path: ready applicant with correctly computed VisitSaudi fields', async () => {
  const result = await checkVisitSaudiApplicantPreflight(GROUP_ID, PASSPORT_IDENTITY_ID, buildDeps());

  assert.equal(result.ready, true);
  if (!result.ready) throw new Error('unreachable');

  assert.equal(result.passportIdentityId, PASSPORT_IDENTITY_ID);
  assert.equal(result.sheetRowNumber, FIRST_DATA_ROW_NUMBER + 3); // matched at rows[3]

  // Expected Date of Arrival/Departure come from groups.departureDate ONLY.
  assert.equal(result.expectedDateOfArrival, '2026-10-26');
  assert.equal(result.expectedDateOfDeparture, '2026-11-09');

  // Sheet column S's own arrivalDate is untouched on the draft, and is a
  // DIFFERENT value from the computed Expected Date of Arrival above --
  // proving the two never got merged or confused.
  assert.equal(result.draft.arrivalDate, '2026-10-01');

  assert.equal(result.maritalStatus, 'MARRIED'); // age 26 at 2026-10-26
  assert.equal(result.profession, 'WORKER'); // 'Erkak'
  assert.equal(result.countryOfBirth, 'UZBEKISTAN');
  assert.equal(result.cityOfBirth, 'Tashkent');
  assert.equal(result.countryOfResidence, 'UZBEKISTAN');
  assert.equal(result.cityOfResidence, 'Tashkent');
  assert.equal(result.draft.portal, 'visitsaudi');
  assert.equal(result.draft.personalPortraitUrl, 'https://example.com/portrait.jpg');
});

test('group not found', async () => {
  const result = await checkVisitSaudiApplicantPreflight(GROUP_ID, PASSPORT_IDENTITY_ID, buildDeps({ group: null }));
  assert.deepEqual(result, { passportIdentityId: PASSPORT_IDENTITY_ID, sheetRowNumber: null, ready: false, errors: [{ reason: 'GROUP_NOT_FOUND' }] });
});

test('no active canonical link for this identity in this group', async () => {
  const result = await checkVisitSaudiApplicantPreflight(GROUP_ID, PASSPORT_IDENTITY_ID, buildDeps({ link: null }));
  assert.deepEqual(result, {
    passportIdentityId: PASSPORT_IDENTITY_ID,
    sheetRowNumber: null,
    ready: false,
    errors: [{ reason: 'NO_ACTIVE_CANONICAL_LINK' }],
  });
});

test('active link exists but its Sheet row cannot be read (readVerifiedApplicantData returns null)', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ data: null, rows: [buildRow('other-1')] }), // row not present either -> sheetRowNumber stays null
  );
  assert.deepEqual(result, {
    passportIdentityId: PASSPORT_IDENTITY_ID,
    sheetRowNumber: null,
    ready: false,
    errors: [{ reason: 'SHEET_ROW_NOT_FOUND' }],
  });
});

test('missing required field (existing validateVerifiedApplicantData behavior preserved unchanged)', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ data: { ...validData, email: '' } }),
  );
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'MISSING_FIELDS');
  assert.ok(result.errors[0].missingFields && result.errors[0].missingFields.length > 0);
});

test('invalid group departure date -> INVALID_DEPARTURE_DATE, never guessed', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ group: { ...mockGroup, departureDate: '2026-02-30' } }),
  );
  assert.deepEqual(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'INVALID_DEPARTURE_DATE');
});

test('marital-status computation failure is surfaced (dependency-injected, decoupled from Date.parse edge cases)', async () => {
  const deps = buildDeps();
  deps.computeMaritalStatus = () => ({ ok: false, reason: 'INVALID_DATE_OF_BIRTH' });
  const result = await checkVisitSaudiApplicantPreflight(GROUP_ID, PASSPORT_IDENTITY_ID, deps);
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'INVALID_DATE_OF_BIRTH');
});

test('unknown nationality is rejected, never guessed', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ data: { ...validData, nationality: 'FRANCE' } }),
  );
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'UNKNOWN_NATIONALITY');
});

test('unrecognized gender (non-blank, so it passes the required-field check, but not Erkak/Ayol) is rejected', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ data: { ...validData, gender: "Noma'lum" } }),
  );
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'UNRECOGNIZED_GENDER');
});

test('checkVisitSaudiGroupPreflight: one applicant failing does not block the others', async () => {
  const linkA: PassportMessageLinkRecord = { ...mockLink, id: 'link-a', passportIdentityId: 'identity-a', telegramMessageId: 'msg-a' };
  const linkB: PassportMessageLinkRecord = { ...mockLink, id: 'link-b', passportIdentityId: 'identity-b', telegramMessageId: 'msg-b' };

  const deps = buildDeps();
  deps.findActiveCanonicalLinksForGroup = async () => [linkA, linkB];
  deps.findActiveCanonicalLink = async (passportIdentityId) => (passportIdentityId === 'identity-a' ? linkA : linkB);
  deps.readVerifiedApplicantData = async (_groupId, passportIdentityId) =>
    passportIdentityId === 'identity-a' ? { ...validData, nationality: 'FRANCE' } : validData;

  const results = await checkVisitSaudiGroupPreflight(GROUP_ID, deps);

  assert.equal(results.length, 2);
  const resultA = results.find((r) => r.passportIdentityId === 'identity-a');
  const resultB = results.find((r) => r.passportIdentityId === 'identity-b');
  assert.ok(resultA && !resultA.ready);
  assert.ok(resultB && resultB.ready);
});

test('checkVisitSaudiGroupPreflight: an unexpected exception for one applicant is captured, not thrown', async () => {
  const deps = buildDeps();
  deps.findActiveCanonicalLinksForGroup = async () => [mockLink];
  deps.readVerifiedApplicantData = async () => {
    throw new Error('simulated Sheets API failure');
  };

  const results = await checkVisitSaudiGroupPreflight(GROUP_ID, deps);

  assert.equal(results.length, 1);
  const [result] = results;
  assert.ok(result);
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'UNEXPECTED_ERROR');
  assert.equal(result.errors[0].detail, 'simulated Sheets API failure');
});

test('only arrivalDate (Sheet column S, "Kirish sanasi") is blank -- does not block VisitSaudi readiness', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ data: { ...validData, arrivalDate: '' } }),
  );
  assert.equal(result.ready, true);
  if (!result.ready) throw new Error('unreachable');
  assert.equal(result.draft.arrivalDate, ''); // left exactly as validateVerifiedApplicantData/buildVisaApplicationDraft produced it
  assert.equal(result.expectedDateOfArrival, '2026-10-26'); // unaffected -- comes from groups.departureDate only
  assert.equal(result.expectedDateOfDeparture, '2026-11-09');
});

test('arrivalDate blank together with another required field -- blocked by the OTHER field, arrivalDate excluded from the reported list', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ data: { ...validData, arrivalDate: '', email: '' } }),
  );
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'MISSING_FIELDS');
  assert.ok(result.errors[0].missingFields);
  assert.ok(!result.errors[0].missingFields!.includes('Kirish sanasi'));
  assert.ok(result.errors[0].missingFields!.includes('Email'));
});

test('a required field OTHER than arrivalDate is blank (arrivalDate itself present) -- blocked exactly as before', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ data: { ...validData, firstName: '' } }),
  );
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'MISSING_FIELDS');
  assert.ok(result.errors[0].missingFields!.includes('Ism'));
});

test('invalid date of birth is never bypassed', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ data: { ...validData, dateOfBirth: '2026-13-01' } }), // month 13 -- Date.parse itself returns NaN for this, unlike a merely out-of-range day
  );
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'INVALID_DATE_OF_BIRTH');
});

test('invalid passport issue date is never bypassed', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ data: { ...validData, passportIssueDate: '2026-13-01' } }),
  );
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'INVALID_ISSUE_DATE');
});

test('expired passport is never bypassed', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ data: { ...validData, passportExpiryDate: '2000-01-01' } }),
  );
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'PASSPORT_EXPIRED');
});

test('invalid email is never bypassed', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ data: { ...validData, email: 'not-an-email' } }),
  );
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'INVALID_EMAIL');
});

test('invalid portrait URL is never bypassed', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ data: { ...validData, personalPortraitUrl: 'not-a-url' } }),
  );
  assert.equal(result.ready, false);
  if (result.ready) throw new Error('unreachable');
  assert.equal(result.errors[0].reason, 'INVALID_PORTRAIT_URL');
});

test('Expected Date of Arrival/Departure stay correct (+14 days, year boundary) regardless of the arrivalDate change above', async () => {
  const result = await checkVisitSaudiApplicantPreflight(
    GROUP_ID,
    PASSPORT_IDENTITY_ID,
    buildDeps({ group: { ...mockGroup, departureDate: '2026-12-20' } }),
  );
  assert.equal(result.ready, true);
  if (!result.ready) throw new Error('unreachable');
  assert.equal(result.expectedDateOfArrival, '2026-12-20');
  assert.equal(result.expectedDateOfDeparture, '2027-01-03');
});
