import type { KsaVisaApplicationDraft, VerifiedApplicantData, VisaApplicationDraft, VisaPortal, VisitSaudiApplicationDraft } from './types.js';

/**
 * Maps already-verified Sheet values (never DB/OCR data -- see
 * readVerifiedApplicantData.ts) onto the exact field shape each portal
 * needs. Pure and side-effect free.
 *
 * VisitSaudi's own draft structurally omits passportScanUrl entirely --
 * per real-world field testing, VisitSaudi never asks for a separate
 * passport scan upload, only the personal/biometric photo. It also
 * structurally omits personalPhotoUrl: the real portal only accepts a
 * face-cropped portrait, never the full, uncropped photo -- so it carries
 * personalPortraitUrl instead, sourced independently from data's own
 * personalPortraitUrl (never falls back to data.personalPhotoUrl under
 * any circumstance). Both fields are absent from VisitSaudiApplicationDraft's
 * own type (see types.ts), not merely left blank, so a future caller
 * cannot accidentally read a passport-scan or full-photo value out of a
 * VisitSaudi draft at all.
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
  };

  if (portal === 'ksavisa') {
    return { ...base, portal: 'ksavisa', personalPhotoUrl: data.personalPhotoUrl, passportScanUrl: data.passportScanUrl };
  }
  return { ...base, portal: 'visitsaudi', personalPortraitUrl: data.personalPortraitUrl };
}
