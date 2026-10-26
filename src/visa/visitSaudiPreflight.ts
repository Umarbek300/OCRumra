import { findGroupById, type Group } from '../db/repositories/groups.repo.js';
import { findActiveCanonicalLink, findActiveCanonicalLinksForGroup } from '../db/repositories/passportMessageLinks.repo.js';
import { ensureGroupSheet } from '../sheets/ensureGroupSheet.js';
import { FIRST_DATA_ROW_NUMBER } from '../sheets/sheetLayout.js';
import { buildRealSheetTitleResolver, type ResolveSheetTitleByGid } from '../sheets/upsertRowInSheet.js';
import { buildRealVisaSheetReadClient, readVerifiedApplicantData, type VisaSheetReadClient } from './readVerifiedApplicantData.js';
import { validateVerifiedApplicantData } from './validateVerifiedApplicantData.js';
import { buildVisaApplicationDraft } from './buildVisaApplicationDraft.js';
import { computeVisitSaudiTripDates } from './computeVisitSaudiTripDates.js';
import { computeMaritalStatusForVisitSaudi, type MaritalStatusForVisitSaudi } from './computeMaritalStatusForVisitSaudi.js';
import { lookupCountryCapital } from './countryCapitalLookup.js';
import { mapGenderToProfessionForVisitSaudi, type ProfessionForVisitSaudi } from './genderProfessionMap.js';
import type { ValidationFailureReason, VisitSaudiApplicationDraft } from './types.js';

/**
 * Same 0-indexed position every other Sheets reader/writer in this
 * codebase already relies on for the hidden technical column M (see
 * readVerifiedApplicantData.ts and upsertRowInSheet.ts) -- never a
 * guessed or assumed row position.
 */
const TECHNICAL_ID_COLUMN_INDEX = 12;

/**
 * Must match validateVerifiedApplicantData.ts's own SHARED_REQUIRED_FIELDS
 * label for 'arrivalDate' EXACTLY (see that file's own source) -- a
 * deliberate, disclosed coupling to a literal string inside a protected
 * file, not a shared constant, since that file cannot be modified to
 * export one. If that label is ever changed there, this filter simply
 * stops matching and VisitSaudi's own arrivalDate-blocking behavior
 * silently reverts to today's (unmodified, stricter) behavior -- the
 * safer failure direction, never the other way around.
 */
const SHEET_ARRIVAL_DATE_FIELD_LABEL = 'Kirish sanasi';

export type VisitSaudiPreflightErrorReason =
  | 'GROUP_NOT_FOUND'
  | 'NO_ACTIVE_CANONICAL_LINK'
  | 'SHEET_ROW_NOT_FOUND'
  | ValidationFailureReason
  | 'INVALID_DEPARTURE_DATE'
  | 'UNKNOWN_NATIONALITY'
  | 'UNRECOGNIZED_GENDER'
  | 'UNEXPECTED_ERROR';

export interface VisitSaudiPreflightError {
  reason: VisitSaudiPreflightErrorReason;
  /** Only ever present for the MISSING_FIELDS reason -- mirrors validateVerifiedApplicantData.ts's own ValidationResult shape. */
  missingFields?: readonly string[];
  /** Only ever present for UNEXPECTED_ERROR -- the caught exception's own message, never logged elsewhere with PII. */
  detail?: string;
}

export interface VisitSaudiReadyApplicant {
  passportIdentityId: string;
  sheetRowNumber: number | null;
  ready: true;
  errors: readonly [];
  /** Exactly buildVisaApplicationDraft(data, 'visitsaudi')'s own, unmodified return value. */
  draft: VisitSaudiApplicationDraft;
  /** Always groups.departureDate, verbatim -- never Sheet column S (VerifiedApplicantData.arrivalDate/draft.arrivalDate), which stays untouched on `draft` above. */
  expectedDateOfArrival: string;
  expectedDateOfDeparture: string;
  maritalStatus: MaritalStatusForVisitSaudi;
  countryOfBirth: string;
  cityOfBirth: string;
  countryOfResidence: string;
  cityOfResidence: string;
  profession: ProfessionForVisitSaudi;
}

export interface VisitSaudiNotReadyApplicant {
  passportIdentityId: string;
  sheetRowNumber: number | null;
  ready: false;
  /**
   * Checks run in a fixed order and stop at the first failure -- mirroring
   * every existing validator in this codebase (validateVerifiedApplicantData,
   * computeVisitSaudiTripDates, computeMaritalStatusForVisitSaudi), which
   * each surface a single reason rather than an exhaustive list. Typed as
   * an array (rather than a bare value) only so a future caller iterating
   * over `errors` doesn't need a separate code path for the not-ready case;
   * it currently always holds exactly one entry.
   */
  errors: readonly [VisitSaudiPreflightError];
}

export type VisitSaudiPreflightResult = VisitSaudiReadyApplicant | VisitSaudiNotReadyApplicant;

export interface VisitSaudiPreflightDependencies {
  findGroup: typeof findGroupById;
  findActiveCanonicalLink: typeof findActiveCanonicalLink;
  findActiveCanonicalLinksForGroup: typeof findActiveCanonicalLinksForGroup;
  readVerifiedApplicantData: typeof readVerifiedApplicantData;
  validate: typeof validateVerifiedApplicantData;
  buildDraft: typeof buildVisaApplicationDraft;
  computeTripDates: typeof computeVisitSaudiTripDates;
  computeMaritalStatus: typeof computeMaritalStatusForVisitSaudi;
  lookupCountryCapital: typeof lookupCountryCapital;
  mapGenderToProfession: typeof mapGenderToProfessionForVisitSaudi;
  ensureSheet: typeof ensureGroupSheet;
  resolveSheetTitle: ResolveSheetTitleByGid;
  readClient: VisaSheetReadClient;
}

const defaultDependencies: VisitSaudiPreflightDependencies = {
  findGroup: findGroupById,
  findActiveCanonicalLink,
  findActiveCanonicalLinksForGroup,
  readVerifiedApplicantData,
  validate: validateVerifiedApplicantData,
  buildDraft: buildVisaApplicationDraft,
  computeTripDates: computeVisitSaudiTripDates,
  computeMaritalStatus: computeMaritalStatusForVisitSaudi,
  lookupCountryCapital,
  mapGenderToProfession: mapGenderToProfessionForVisitSaudi,
  ensureSheet: ensureGroupSheet,
  resolveSheetTitle: buildRealSheetTitleResolver(),
  readClient: buildRealVisaSheetReadClient(),
};

/**
 * Finds this applicant's OWN current row number in the Sheet, via the
 * exact same mechanism upsertRowInSheet.ts already uses for its own
 * row-placement decisions (content-match against the hidden technical
 * column M, never a row index assumed from `created_at` order or from
 * any other ordering). Duplicates that lookup rather than modifying
 * readVerifiedApplicantData.ts (protected) to also return it -- at the
 * cost of one extra Sheets read per applicant, which is acceptable for a
 * preflight check (not a hot loop).
 *
 * Returns null if the row cannot be found (should not normally happen for
 * an active canonical link, since its message was synced there -- treated
 * as "unknown position" rather than thrown, consistent with this
 * codebase's not_found-is-not-a-failure convention).
 */
async function resolveSheetRowNumber(
  group: Group,
  telegramMessageId: string,
  deps: Pick<VisitSaudiPreflightDependencies, 'ensureSheet' | 'resolveSheetTitle' | 'readClient'>,
): Promise<number | null> {
  const { spreadsheetId } = await deps.ensureSheet(group.id);
  const sheetTitle =
    group.googleSheetGid !== undefined && group.googleSheetGid !== null
      ? await deps.resolveSheetTitle(spreadsheetId, group.googleSheetGid)
      : undefined;
  const rows = await deps.readClient.getAllDataRows(spreadsheetId, sheetTitle);
  const index = rows.findIndex((row) => row[TECHNICAL_ID_COLUMN_INDEX] === telegramMessageId);
  return index === -1 ? null : FIRST_DATA_ROW_NUMBER + index;
}

/**
 * Checks ONE applicant's readiness for a VisitSaudi application, without
 * ever submitting anything anywhere. Read-only end to end: reads the
 * group, the Sheet (via the unmodified, protected readVerifiedApplicantData),
 * and this applicant's own row position; writes nothing, to the Sheet, the
 * DB, Telegram, or the portal.
 *
 * Reuses validateVerifiedApplicantData and buildVisaApplicationDraft
 * EXACTLY as they exist today (both protected, both called unmodified) --
 * every existing required-field/format check they already perform (Sheet
 * column S's own `arrivalDate` requirement included) stays in force,
 * completely untouched by the new checks added here. The NEW "Expected
 * Date of Arrival/Departure" is computed entirely separately, from
 * `group.departureDate` only -- data.arrivalDate (Sheet column S) is never
 * read for that computation and never appears anywhere in the ready-result
 * below except, unchanged, inside `draft` (which validateVerifiedApplicantData/
 * buildVisaApplicationDraft already populated the ordinary way).
 */
export async function checkVisitSaudiApplicantPreflight(
  groupId: string,
  passportIdentityId: string,
  deps: VisitSaudiPreflightDependencies = defaultDependencies,
): Promise<VisitSaudiPreflightResult> {
  const notReady = (sheetRowNumber: number | null, error: VisitSaudiPreflightError): VisitSaudiNotReadyApplicant => ({
    passportIdentityId,
    sheetRowNumber,
    ready: false,
    errors: [error],
  });

  const group = await deps.findGroup(groupId);
  if (!group) {
    return notReady(null, { reason: 'GROUP_NOT_FOUND' });
  }

  const activeCanonical = await deps.findActiveCanonicalLink(passportIdentityId, groupId);
  if (!activeCanonical) {
    return notReady(null, { reason: 'NO_ACTIVE_CANONICAL_LINK' });
  }

  const sheetRowNumber = await resolveSheetRowNumber(group, activeCanonical.telegramMessageId, deps);

  const data = await deps.readVerifiedApplicantData(groupId, passportIdentityId);
  if (!data) {
    return notReady(sheetRowNumber, { reason: 'SHEET_ROW_NOT_FOUND' });
  }

  const validation = deps.validate(data, 'visitsaudi');
  if (!validation.ready) {
    // VisitSaudi's own Expected Date of Arrival/Departure are computed
    // entirely from groups.departureDate (see computeTripDates below) --
    // never from Sheet column S's own arrivalDate. validateVerifiedApplicantData
    // (protected, called above unmodified) still requires arrivalDate to be
    // non-blank for every portal; when that is the ONLY missing field, it
    // must not block VisitSaudi readiness. Any OTHER missing field, or any
    // other validation reason entirely, still blocks exactly as before --
    // nothing else is ever filtered out of `missingFields`.
    if (validation.reason === 'MISSING_FIELDS' && validation.missingFields) {
      const remainingMissingFields = validation.missingFields.filter((label) => label !== SHEET_ARRIVAL_DATE_FIELD_LABEL);
      if (remainingMissingFields.length > 0) {
        return notReady(sheetRowNumber, { reason: 'MISSING_FIELDS', missingFields: remainingMissingFields });
      }
      // else: Sheet column S's "Kirish sanasi" was the only missing field --
      // fall through, not a VisitSaudi blocker.
    } else {
      return notReady(
        sheetRowNumber,
        validation.missingFields
          ? { reason: validation.reason, missingFields: validation.missingFields }
          : { reason: validation.reason },
      );
    }
  }

  const tripDates = deps.computeTripDates(group.departureDate);
  if (!tripDates.ok) {
    return notReady(sheetRowNumber, { reason: tripDates.reason });
  }

  const maritalStatus = deps.computeMaritalStatus(data.dateOfBirth, group.departureDate);
  if (!maritalStatus.ok) {
    return notReady(sheetRowNumber, { reason: maritalStatus.reason });
  }

  const countryCapital = deps.lookupCountryCapital(data.nationality);
  if (!countryCapital.ok) {
    return notReady(sheetRowNumber, { reason: countryCapital.reason });
  }

  const profession = deps.mapGenderToProfession(data.gender);
  if (!profession.ok) {
    return notReady(sheetRowNumber, { reason: profession.reason });
  }

  return {
    passportIdentityId,
    sheetRowNumber,
    ready: true,
    errors: [],
    draft: deps.buildDraft(data, 'visitsaudi'),
    expectedDateOfArrival: tripDates.dates.arrivalDate,
    expectedDateOfDeparture: tripDates.dates.departureFromSaudiDate,
    maritalStatus: maritalStatus.maritalStatus,
    countryOfBirth: countryCapital.entry.country,
    cityOfBirth: countryCapital.entry.capitalCity,
    countryOfResidence: countryCapital.entry.country,
    cityOfResidence: countryCapital.entry.capitalCity,
    profession: profession.profession,
  };
}

/**
 * Runs checkVisitSaudiApplicantPreflight independently for every active
 * canonical applicant in a group (the same source visaAssignCommand.ts
 * already uses -- never a guessed order). One applicant's unexpected
 * exception is caught and reported as that applicant's own
 * UNEXPECTED_ERROR result; it never aborts the rest of the group, mirroring
 * visaAssignCommand.ts's own per-applicant try/catch convention.
 */
export async function checkVisitSaudiGroupPreflight(
  groupId: string,
  deps: VisitSaudiPreflightDependencies = defaultDependencies,
): Promise<VisitSaudiPreflightResult[]> {
  const links = await deps.findActiveCanonicalLinksForGroup(groupId);
  const results: VisitSaudiPreflightResult[] = [];

  for (const link of links) {
    try {
      results.push(await checkVisitSaudiApplicantPreflight(groupId, link.passportIdentityId, deps));
    } catch (error) {
      results.push({
        passportIdentityId: link.passportIdentityId,
        sheetRowNumber: null,
        ready: false,
        errors: [{ reason: 'UNEXPECTED_ERROR', detail: error instanceof Error ? error.message : 'unknown error' }],
      });
    }
  }

  return results;
}
