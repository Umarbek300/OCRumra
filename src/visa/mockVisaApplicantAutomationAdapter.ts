import type { VisaApplicantAutomationAdapter, VisaApplicantAutomationResult } from './visaApplicantAutomationAdapter.js';
import type { VisitSaudiApplicationDraft } from './types.js';
import type { MaritalStatusForVisitSaudi } from './computeMaritalStatusForVisitSaudi.js';
import type { ProfessionForVisitSaudi } from './genderProfessionMap.js';

export interface MockVisaApplicantAutomationCall {
  recordId: string;
  draft: VisitSaudiApplicationDraft;
  isLastApplicantInBatch: boolean;
  maritalStatus: MaritalStatusForVisitSaudi;
  countryOfBirth: string;
  cityOfBirth: string;
  countryOfResidence: string;
  cityOfResidence: string;
  profession: ProfessionForVisitSaudi;
  expectedDateOfArrival: string;
  expectedDateOfDeparture: string;
}

export interface BuildMockVisaApplicantAutomationAdapterOptions {
  /** Keyed by recordId -- the exact, pre-determined result returned for that applicant's submitApplicant call. */
  resultsByRecordId: Record<string, VisaApplicantAutomationResult>;
  /** recordIds in this list throw instead of resolving -- simulates a worker/automation crash or an unhandled exception mid-submission (see visaWorkerLoop.ts's own handling: treated as "outcome unknown", never a guessed SAVED). */
  throwForRecordIds?: readonly string[];
}

/**
 * Deterministic, network-free, portal-free test double for
 * VisaApplicantAutomationAdapter -- imports nothing from
 * visitSaudiAutomation.ts and makes no HTTP/browser call of any kind
 * (grep this file: no `fetch`, no `http`, no `playwright`/`puppeteer`,
 * no literal portal URL).
 *
 * Every call is recorded in `calls` (so a test can assert automation was,
 * or crucially was NOT, invoked -- e.g. after a failed preflight check).
 * Resolves/throws STRICTLY according to the options a test passed in --
 * never a random or time-based result, and never a silent default: an
 * unconfigured recordId throws loudly rather than returning some
 * made-up outcome, so a test can never accidentally pass by coincidence.
 */
export function buildMockVisaApplicantAutomationAdapter(
  options: BuildMockVisaApplicantAutomationAdapterOptions,
): VisaApplicantAutomationAdapter & { readonly calls: readonly MockVisaApplicantAutomationCall[] } {
  const calls: MockVisaApplicantAutomationCall[] = [];

  return {
    calls,
    async submitApplicant(input: {
      recordId: string;
      draft: VisitSaudiApplicationDraft;
      isLastApplicantInBatch: boolean;
      maritalStatus: MaritalStatusForVisitSaudi;
      countryOfBirth: string;
      cityOfBirth: string;
      countryOfResidence: string;
      cityOfResidence: string;
      profession: ProfessionForVisitSaudi;
      expectedDateOfArrival: string;
      expectedDateOfDeparture: string;
    }): Promise<VisaApplicantAutomationResult> {
      calls.push({
        recordId: input.recordId,
        draft: input.draft,
        isLastApplicantInBatch: input.isLastApplicantInBatch,
        maritalStatus: input.maritalStatus,
        countryOfBirth: input.countryOfBirth,
        cityOfBirth: input.cityOfBirth,
        countryOfResidence: input.countryOfResidence,
        cityOfResidence: input.cityOfResidence,
        profession: input.profession,
        expectedDateOfArrival: input.expectedDateOfArrival,
        expectedDateOfDeparture: input.expectedDateOfDeparture,
      });

      if (options.throwForRecordIds?.includes(input.recordId)) {
        throw new Error(`mock automation: simulated crash/unhandled exception for recordId ${input.recordId}`);
      }

      const result = options.resultsByRecordId[input.recordId];
      if (!result) {
        throw new Error(
          `mock automation: no pre-configured result for recordId ${input.recordId} -- tests must always configure an explicit outcome, never rely on an unconfigured/random one`,
        );
      }
      return result;
    },
  };
}
