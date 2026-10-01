import type { KsaVisaApplicationDraft, VerifiedApplicantData, VisaApplicationDraft, VisaPortal, VisitSaudiApplicationDraft } from './types.js';

/**
 * Maps already-verified Sheet values (never DB/OCR data -- see
 * readVerifiedApplicantData.ts) onto the exact field shape each portal
 * needs. Pure and side-effect free.
 *
 * VisitSaudi's own draft structurally omits passportScanUrl entirely --
 * per real-world field testing, VisitSaudi never asks for a separate
 * passport scan upload, only the personal/biometric photo. The field is
 * absent from VisitSaudiApplicationDraft's own type (see types.ts), not
 * merely left blank, so a future caller cannot accidentally read a
 * passport-scan value out of a VisitSaudi draft at all.
 */
export function buildVisaApplicationDraft(data: VerifiedApplicantData, portal: 'visitsaudi'): VisitSaudiApplicationDraft;
export function buildVisaApplicationDraft(data: VerifiedApplicantData, portal: 'ksavisa'): KsaVisaApplicationDraft;
export function buildVisaApplicationDraft(data: VerifiedApplicantData, portal: VisaPortal): VisaApplicationDraft {
  const base = {
    firstName: data.firstName,
    surname: data.surname,
    dateOfBirth: data.dateOfBirth,
    gender: data.gender,
    passportNumber: data.passportNumber,
    passportIssueDate: data.passportIssueDate,
    passportExpiryDate: data.passportExpiryDate,
    nationality: data.nationality,
    email: data.email,
    arrivalDate: data.arrivalDate,
    personalPhotoUrl: data.personalPhotoUrl,
  };

  if (portal === 'ksavisa') {
    return { ...base, portal: 'ksavisa', passportScanUrl: data.passportScanUrl };
  }
  return { ...base, portal: 'visitsaudi' };
}
