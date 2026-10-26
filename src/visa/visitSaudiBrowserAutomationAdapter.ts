import type { Page } from 'playwright';
import type { VisaApplicantAutomationAdapter, VisaApplicantAutomationResult } from './visaApplicantAutomationAdapter.js';
import { cleanupDownloadedTempFile } from './downloadUrlToTempFile.js';
import {
  answerApplyingOnBehalfOfSomeoneElse,
  clickSave,
  clickSaveAndMoveToNextApplicant,
  confirmInsuranceConsent,
  CONFIRMED_APPLYING_ON_BEHALF_OF_SOMEONE_ELSE_ANSWER,
  fillApplicantPersonalInfoFields,
  fillApplicantTripDetailsFields,
  isAnchorVisible,
  uploadApplicantPortraitFromUrl,
} from './visitSaudiPageActions.js';

/**
 * ============================================================================
 * Package 5.28 -- the real VisaApplicantAutomationAdapter, built from
 * visitSaudiPageActions.ts's evidence-verified actions.
 * ============================================================================
 *
 * SCOPE: this adapter implements ONLY the per-applicant SAVE step
 * (VisaApplicantAutomationAdapter's own contract). Group creation
 * (createVisitSaudiGroup, visitSaudiPageActions.ts) is a SEPARATE,
 * already-implemented, standalone function, deliberately NOT called from
 * here -- VisaApplicantAutomationAdapter.submitApplicant is called ONCE
 * PER APPLICANT (visaWorkerLoop.ts's own per-item loop), with no existing
 * hook for "do this once before the batch's first applicant." Wiring
 * group creation into this adapter would mean GUESSING at that
 * architecture (lazily-on-first-call? a separate pre-step? idempotency
 * tracking?) rather than reusing a decision that has actually been made.
 * The caller is responsible for calling createVisitSaudiGroup itself,
 * once, before ever constructing/using this adapter for a batch.
 *
 * CURRENT REAL BEHAVIOR, per applicant:
 *   1. Answer "Are you applying on behalf of someone else?" (confirmed
 *      YES, see CONFIRMED_APPLYING_ON_BEHALF_OF_SOMEONE_ELSE_ANSWER) --
 *      real page order places this ABOVE the portrait/personal fields.
 *   2. Upload the applicant's portrait (uploadApplicantPortraitFromUrl --
 *      real, verified, already tested against a real browser context).
 *   3. Fill the personal-info fields (fillApplicantPersonalInfoFields) --
 *      Package 5.36: every Page 3 field is now evidence-backed and
 *      filled, including Gender/Marital Status/Date of Birth (see that
 *      function's own doc comment for the exact recovered screenshots
 *      each one relies on). This call no longer throws by design --
 *      only an unexpected real-portal condition (a locator that doesn't
 *      resolve, an unmapped gender, a malformed date) would make it throw.
 *   4. If step 3 throws anyway, SAVE is NEVER attempted -- clicking SAVE on an
 *      incompletely-filled real visa application form would be actively
 *      harmful, not merely premature. The thrown error propagates out of
 *      submitApplicant UNCAUGHT, deliberately: visaWorkerLoop.ts's own
 *      processOneApplicant already treats a thrown automation error as
 *      UNEXPECTED_ERROR, leaving the record SUBMITTING for stale-recovery
 *      to pick up later -- the EXACT safe, non-guessing behavior this
 *      situation needs, via EXISTING, already-tested orchestration. This
 *      adapter does not duplicate that handling, and does not invent an
 *      AMBIGUOUS/ERROR outcome of its own for "automation isn't ready" --
 *      that would blur a genuine portal-observed outcome with a
 *      structural implementation gap, which are not the same thing.
 *   5. Once step 3 no longer throws, the SAVE action is chosen by
 *      chooseSaveAction (exported separately so its own logic is
 *      directly testable without needing the rest of this file to be
 *      reachable yet): SAVE AND MOVE TO THE NEXT APPLICANT for applicants
 *      1-9 of a batch of 10, plain SAVE for applicant 10 (this project's
 *      own approved business rule, Package 5.31). Per that same Package
 *      5.31 decision, the click succeeding (resolving without throwing)
 *      IS the required action -- no toast/banner/URL/group-overview
 *      detection is layered on top, and the outcome is reported as SAVED
 *      on that basis alone. This is a reporting simplification, not a
 *      stronger claim: it does not assert the portal durably persisted
 *      the save, only that this adapter does not second-guess a
 *      successful button click with unverified confirmation logic.
 *      (confirmSaveOutcome, visitSaudiPageActions.ts, remains deliberately
 *      un-implemented and is no longer called from this file -- kept only
 *      as a placeholder for a possible future stricter mode, should real
 *      confirmation evidence ever surface.) If the click ITSELF throws
 *      (element not found, navigation error, etc.), that is a genuine
 *      failure, not a successful-click-but-unconfirmed-result -- it
 *      propagates uncaught via the same UNEXPECTED_ERROR path as step 3's
 *      throw, so it is never guessed as SAVED and never auto-resubmitted
 *      (see visaWorkerLoop.ts / tests [7a]/[7b], visa.visaWorkerLoop.test.ts).
 *   6. Package 5.38: the real per-applicant navigation AFTER a successful
 *      SAVE / SAVE AND MOVE TO THE NEXT APPLICANT click has never been
 *      confirmed -- it may advance straight to the next applicant's own
 *      Page 3 (never showing Pages 4/5 for THIS applicant at all), or it
 *      may advance to THIS applicant's own Page 4 ("Passport & Trip
 *      Details") first. Rather than guess either way, this is a SAFE
 *      PAGE-CHECK (isAnchorVisible, visitSaudiPageActions.ts): briefly,
 *      non-throwingly wait to see which actually happened.
 *        - Page 4's own confirmed anchor ("Passport Type") never appears
 *          -> treated as the normal "no extra page for this applicant
 *          right now" case, exactly today's already-tested SAVED
 *          behavior, unchanged.
 *        - It DOES appear -> fillApplicantTripDetailsFields is called
 *          for real. As of Package 5.39 this function fills every
 *          evidence-backed Page 4 field (including both Communication
 *          Preference answers) AND makes a general, best-effort attempt
 *          to select the Hotel field's real autocomplete suggestion
 *          (fillHotelNameAndSelectSuggestion -- matches ANY visible
 *          element whose own text contains every word of the expected
 *          hotel name, so it can never click a WRONG hotel; if none ever
 *          appears, the typed text is simply left as-is). This function
 *          no longer throws for that reason -- whether the suggestion was
 *          actually found is reported back via its own
 *          hotelSuggestionSelected result field and surfaced here as
 *          this applicant's own `detail` string when it was NOT found,
 *          purely informational, never blocking SAVED.
 *        - Package 5.40: fillApplicantTripDetailsFields's OWN final step
 *          now clicks Page 4's confirmed `Next >` button (clickNext,
 *          visitSaudiPageActions.ts) once every field above it is filled
 *          -- this click is treated as a genuine, confirmed action (the
 *          button itself is confirmed to exist), so a failure to find/
 *          click it propagates uncaught, same as any other confirmed-
 *          element action in this file. Whether that click actually
 *          reveals Page 5 has never been confirmed, so the SAME safe
 *          page-check is repeated for Page 5's own anchor
 *          ("INSURANCE COVERAGE"): only if it appears is
 *          confirmInsuranceConsent called -- and EITHER way, the outcome
 *          (reached-and-confirmed, or not-reached) is always recorded in
 *          this applicant's own `detail` string, never left silent, so
 *          "Page 5 never appeared" can never be mistaken for a quiet
 *          success.
 *      The Legal Declaration page, `PAY FOR GROUP`, and
 *      `AGREE & COMPLETE PAYMENT` are never checked for or reached by
 *      this chain, by design -- see this file's own closing note below.
 *   7. The downloaded portrait's local temp file is ALWAYS cleaned up in
 *      a `finally`, whether any step above succeeds, throws, or anything
 *      later throws -- the attempt for THIS applicant is over either way,
 *      so the browser no longer needs that file once this call returns
 *      or throws, regardless of which branch was reached.
 *
 * CAPTCHA, OTP, PAY FOR GROUP, payment, and the legal declaration are
 * never targeted anywhere in this file, directly or indirectly, and no
 * future change to this file may add that either.
 */

/**
 * Pure decision logic, extracted so it is directly testable independent
 * of the rest of this file. Mirrors this project's own approved workflow
 * decision exactly: every applicant except the batch's last one uses
 * SAVE AND MOVE TO THE NEXT APPLICANT; the last one uses plain SAVE.
 */
export function chooseSaveAction(isLastApplicantInBatch: boolean): (page: Page) => Promise<void> {
  return isLastApplicantInBatch ? clickSave : clickSaveAndMoveToNextApplicant;
}

/**
 * Builds the real adapter against an already-open Playwright `page` --
 * the caller is responsible for that page already being on the real
 * VisitSaudi "Apply for Group" form for the correct batch's group (see
 * this file's own SCOPE note above about group creation being a separate
 * concern).
 */
export function buildVisitSaudiBrowserAutomationAdapter(page: Page): VisaApplicantAutomationAdapter {
  return {
    async submitApplicant(input): Promise<VisaApplicantAutomationResult> {
      // Real page order (per Package 5.36's recovered screenshot): the
      // "applying on behalf" question appears ABOVE the portrait/personal
      // fields, so it is answered first.
      await answerApplyingOnBehalfOfSomeoneElse(page, CONFIRMED_APPLYING_ON_BEHALF_OF_SOMEONE_ELSE_ANSWER);
      const portraitPath = await uploadApplicantPortraitFromUrl(page, input.draft.personalPortraitUrl);
      try {
        await fillApplicantPersonalInfoFields(page, {
          draft: input.draft,
          maritalStatus: input.maritalStatus,
          countryOfBirth: input.countryOfBirth,
          cityOfBirth: input.cityOfBirth,
          countryOfResidence: input.countryOfResidence,
          cityOfResidence: input.cityOfResidence,
          profession: input.profession,
        });

        // Per Package 5.31's approved business rule: the correct SAVE
        // button resolving (not throwing) IS the required action -- no
        // further confirmation is awaited or required before reporting SAVED.
        const saveAction = chooseSaveAction(input.isLastApplicantInBatch);
        await saveAction(page);

        // Package 5.38: safe page-check, never a guess -- see this
        // file's own doc comment (step 6) for the full reasoning.
        const detailParts: string[] = [];
        if (await isAnchorVisible(page, 'Passport Type')) {
          const tripDetailsResult = await fillApplicantTripDetailsFields(page, {
            draft: input.draft,
            countryOfBirth: input.countryOfBirth,
            expectedDateOfArrival: input.expectedDateOfArrival,
            expectedDateOfDeparture: input.expectedDateOfDeparture,
          });
          // Package 5.39: the Hotel field's suggestion-selection is a
          // best-effort attempt (see fillApplicantTripDetailsFields's own
          // doc comment) -- never a required condition for SAVED, but
          // surfaced here as free-form diagnostic detail so a worker
          // operator can tell, after the fact, whether the real portal's
          // suggestion was actually found and clicked for this applicant.
          // Typing the hotel name alone is NEVER reported as "selected" --
          // only tripDetailsResult.hotelSuggestionSelected (itself only
          // true when a real matching suggestion was actually clicked)
          // decides this.
          if (!tripDetailsResult.hotelSuggestionSelected) {
            detailParts.push('hotel autocomplete suggestion was not found/selected within the bounded wait; the typed hotel name was left as-is');
          }

          // Package 5.40: fillApplicantTripDetailsFields's own final step
          // clicks Page 4's confirmed Next button, but whether that
          // actually reveals Page 5 (Insurance) has never been confirmed.
          // This safe page-check never assumes either outcome -- and,
          // per this package's own requirement, NEITHER outcome is left
          // silent: whichever happens is always recorded in `detail`,
          // so "Page 5 never appeared" can never be mistaken for a
          // quiet success.
          if (await isAnchorVisible(page, 'INSURANCE COVERAGE')) {
            await confirmInsuranceConsent(page);
            detailParts.push('Page 5 (Insurance) reached and consent confirmed');
          } else {
            detailParts.push('Page 5 (Insurance) did not appear after Page 4\'s Next click -- insurance consent NOT confirmed');
          }
        }

        return detailParts.length > 0 ? { outcome: 'SAVED', detail: detailParts.join('; ') } : { outcome: 'SAVED' };
      } finally {
        await cleanupDownloadedTempFile(portraitPath);
      }
    },
  };
}
