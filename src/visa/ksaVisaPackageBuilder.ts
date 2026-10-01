import { buildVisaApplicationDraft } from './buildVisaApplicationDraft.js';
import type { KsaVisaApplicationDraft, VerifiedApplicantData } from './types.js';

export interface KsaVisaPackage {
  draft: KsaVisaApplicationDraft;
}

/**
 * KSA Visa never batches -- unlike VisitSaudi, there is no "Group
 * application" concept here at all (the portal requires the Saudi-side
 * sponsor's own Nafath identity, which OCRumra's operator can never hold).
 * This builds exactly one applicant's package at a time, for handoff to
 * that sponsor; see the implementation-ready specification this module was
 * planned against for the full (entirely manual, from here on) workflow.
 */
export function buildKsaVisaPackage(data: VerifiedApplicantData): KsaVisaPackage {
  return { draft: buildVisaApplicationDraft(data, 'ksavisa') };
}
