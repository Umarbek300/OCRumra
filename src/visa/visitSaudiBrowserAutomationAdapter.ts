import type { Page } from 'playwright';
import type { VisaApplicantAutomationAdapter, VisaApplicantAutomationResult } from './visaApplicantAutomationAdapter.js';
import { cleanupDownloadedTempFile } from './downloadUrlToTempFile.js';
import {
  answerApplyingOnBehalfOfSomeoneElse,
  clickNext,
  clickSave,
  clickSaveAndMoveToNextApplicant,
  confirmInsuranceConsent,
  confirmTermsAndConditions,
  CONFIRMED_APPLYING_ON_BEHALF_OF_SOMEONE_ELSE_ANSWER,
  fillApplicantPersonalInfoFields,
  fillApplicantTripDetailsFields,
  isAnchorVisible,
  TERMS_AND_CONDITIONS_ANCHOR,
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
 * once, before ever constructing/using this adapter for a batch --
 * createVisitSaudiGroup's own updated rule now additionally CONFIRMS the
 * group was actually created (waits for Page 3's own anchor) before
 * returning, so this adapter can trust that precondition.
 *
 * ============================================================================
 * Page3->Page7 FLOW FIX (this package): corrects a real architectural
 * mistake, grounded in the operator's own hands-on real-portal evidence.
 * ============================================================================
 * EVERY earlier package here assumed the per-applicant "SAVE AND MOVE TO
 * THE NEXT APPLICANT" / "SAVE" action is clicked immediately after Page 3
 * (personal info). The operator's own real, hands-on use of the actual
 * VisitSaudi portal (recorded in this engagement's own prior audit
 * rounds) showed this is WRONG: the real multi-page wizard is Page 3 ->
 * Page 4 -> Page 5 -> Page 6 -> Page 7 (Review Application), and the
 * real per-applicant "continue" action -- which may not even be the
 * exact text "SAVE AND MOVE TO THE NEXT APPLICANT" (the operator's own
 * observation names a "Save & Add Applicant" link) -- lives on Page 7,
 * never on Page 3. Because no real portal automation run has ever
 * actually executed against the real portal (this engagement's own
 * standing rule), this was a real but never-yet-triggered mistake, fixed
 * here before it could ever run for real.
 *
 * What is, and is NOT, fixable right now: Page 3's own fields
 * (fillApplicantPersonalInfoFields) and Page 4's own fields
 * (fillApplicantTripDetailsFields, with its own confirmed `Next >`
 * button) are each independently evidence-backed and unchanged. Page 5's
 * own confirmed anchor ("INSURANCE COVERAGE") and consent checkbox are
 * also unchanged.
 *
 * Page3->Page4 TRIGGER FIX (later package, same flow-fix family): the
 * operator's own real-portal observation -- Page 3 (confirmed by its own
 * "UPLOAD FILE" anchor) filled, its optional fields left blank, then
 * "Next" pressed to advance -- is now reused here via the SAME generic
 * `clickNext` already relied on for Page 4's own Next button
 * (visitSaudiPageActions.ts). This is grounded in the operator's own
 * description, not an independently re-verified screenshot crop like
 * Page 4's own Next button got, so a failure to find/click it is handled
 * as a genuine, reported uncertainty (AMBIGUOUS), never silently guessed
 * as success -- see step 5 below.
 *
 * Page7 SAVE FIX (later package, same flow-fix family): Page 6's own
 * consent checkbox (TERMS_AND_CONDITIONS_ANCHOR/confirmTermsAndConditions)
 * and BOTH of Page 7's own actions -- "Save & Add Applicant" (applicants
 * 1-9) and the real `<a id="aSave" href="/Visa/Save">Save</a>` (applicant
 * 10) -- are now independently confirmed via the operator's own real
 * Inspect-element capture, correcting this file's own and
 * visitSaudiPageActions.ts's own earlier INVENTED/assumed text for the
 * latter two (see clickSave/clickSaveAndMoveToNextApplicant's own doc
 * comments for exactly what was wrong and how it was corrected). This
 * adapter now reaches, and completes, Page 6 and Page 7 for real -- see
 * step 5 below for the full, current chain.
 *
 * CURRENT REAL BEHAVIOR, per applicant:
 *   1. Answer "Are you applying on behalf of someone else?" (confirmed
 *      YES, see CONFIRMED_APPLYING_ON_BEHALF_OF_SOMEONE_ELSE_ANSWER) --
 *      real page order places this ABOVE the portrait/personal fields.
 *   2. Upload the applicant's portrait (uploadApplicantPortraitFromUrl --
 *      real, verified, already tested against a real browser context).
 *      KNOWN, OPENLY-FLAGGED GAP (unchanged by this package): the only
 *      signal this adapter has that the upload "succeeded" is that the
 *      browser call itself did not throw -- there is no confirmed
 *      real-portal visual signal (a thumbnail, an echoed filename, an
 *      upload-progress indicator) that the upload was actually accepted
 *      server-side. This adapter does not, and must not, invent one: an
 *      uncertain upload is never silently treated as a success beyond
 *      "the call resolved."
 *   3. Fill the personal-info fields (fillApplicantPersonalInfoFields) --
 *      Package 5.36: every Page 3 field is now evidence-backed and
 *      filled, including Gender/Marital Status/Date of Birth (see that
 *      function's own doc comment for the exact recovered screenshots
 *      each one relies on, and for the OPENLY-FLAGGED date-field gap:
 *      every date is still filled via `.fill()`, not a real calendar
 *      widget, because no confirmed calendar DOM evidence exists yet --
 *      see that file's own flagged note). This call no longer throws by
 *      design -- only an unexpected real-portal condition (a locator
 *      that doesn't resolve, an unmapped gender, a malformed date) would
 *      make it throw.
 *   4. If step 3 throws, the error propagates out of submitApplicant
 *      UNCAUGHT, deliberately: visaWorkerLoop.ts's own processOneApplicant
 *      already treats a thrown automation error as UNEXPECTED_ERROR,
 *      leaving the record SUBMITTING for stale-recovery to pick up later
 *      -- the EXACT safe, non-guessing behavior this situation needs, via
 *      EXISTING, already-tested orchestration. This adapter does not
 *      duplicate that handling.
 *   5. Once step 3 no longer throws, this adapter NEVER clicks SAVE /
 *      SAVE AND MOVE TO THE NEXT APPLICANT here -- that is this
 *      package's own fix (see the flow-fix note above: that action
 *      belongs on Page 7, not here). Instead, it clicks Page 3's own
 *      forward action (clickNext -- see the Page3->Page4 trigger-fix note
 *      above) and then performs a SAFE, non-throwing PAGE-CHECK
 *      (isAnchorVisible, visitSaudiPageActions.ts) for Page 4's own
 *      confirmed anchor ("Passport Type"):
 *        - The Next click itself could not be found/clicked -> reported
 *          AMBIGUOUS (a genuine, unresolved uncertainty, never a known
 *          handoff), and this adapter stops without advancing.
 *        - The click resolved, but the anchor never appears afterward ->
 *          also AMBIGUOUS (something was clicked and did not produce the
 *          expected result -- never guessed as having advanced).
 *        - The anchor DOES appear -> fillApplicantTripDetailsFields is
 *          called for real. This function fills every
 *          evidence-backed Page 4 field (including both Communication
 *          Preference answers) AND makes a general, best-effort attempt
 *          to select the Hotel field's real autocomplete suggestion
 *          (fillHotelNameAndSelectSuggestion -- matches ANY visible
 *          element whose own text contains every word of the expected
 *          hotel name, so it can never click a WRONG hotel).
 *
 *          If that suggestion is never found/selected,
 *          fillApplicantTripDetailsFields deliberately does NOT click
 *          Page 4's `Next >` button and does NOT advance to Page 5 --
 *          reported back via its own `advancedToNextPage: false`. This is
 *          a genuine, unresolved uncertainty (not a known handoff), so
 *          this adapter reports AMBIGUOUS, unchanged from before.
 *
 *          Only when the hotel selection IS confirmed does
 *          fillApplicantTripDetailsFields click Next, and this adapter
 *          then repeats the SAME safe page-check for Page 5's own anchor
 *          ("INSURANCE COVERAGE"):
 *            - It DOES appear -> Page5->Page6 TRIGGER FIX (later package):
 *              the operator explicitly authorized -- twice, each time with
 *              the fact that this checkbox is actually a per-applicant fee
 *              acceptance (see confirmInsuranceConsent's own doc comment)
 *              disclosed and acknowledged -- automatically confirming
 *              insurance consent (confirmInsuranceConsent) and clicking
 *              Next (clickNext), rather than stopping for a human to do
 *              it. A failure to do either is reported AMBIGUOUS (genuine,
 *              unresolved uncertainty). On success, this adapter repeats
 *              the SAME safe page-check for Page 6's own now-confirmed
 *              anchor (TERMS_AND_CONDITIONS_ANCHOR):
 *                - It DOES appear -> Page6->Page7 TRIGGER FIX: automatically
 *                  confirms the terms checkbox (confirmTermsAndConditions --
 *                  its own doc comment flags the open, unconfirmed gap of
 *                  whether Page 6 has OTHER required checkboxes beside
 *                  this one) and clicks Next. A failure is AMBIGUOUS. On
 *                  success, this adapter repeats the SAME safe page-check
 *                  for Page 7's own expected action -- "Save & Add
 *                  Applicant" for applicants 1-9, or "Save" for the
 *                  batch's last applicant (page7ActionAnchor, chosen from
 *                  `input.isLastApplicantInBatch`, the SAME flag
 *                  chooseSaveAction below already keys off):
 *                    - It DOES appear -> Page7 SAVE FIX: clicks that exact
 *                      action for real (chooseSaveAction). A failure is
 *                      AMBIGUOUS. On success, this project's own
 *                      earlier-approved rule (confirmSaveOutcome's own doc
 *                      comment) treats a non-throwing click as the
 *                      required, SUFFICIENT signal -- no further UI
 *                      confirmation exists or is invented. Reported SAVED
 *                      -- the ONLY path in this file that does.
 *                    - It does NOT appear -> AMBIGUOUS, unchanged pattern.
 *                - It does NOT appear -> AMBIGUOUS, unchanged pattern.
 *            - It does NOT appear -> genuinely unconfirmed page state
 *              after a real Next click that itself resolved -- reported
 *              AMBIGUOUS, unchanged from before.
 *      The Legal Declaration page (if distinct from Page 6's own terms
 *      checkbox -- never confirmed either way), `PAY FOR GROUP`, and
 *      `AGREE & COMPLETE PAYMENT` are still never reached or clicked by
 *      this chain -- `PAY FOR GROUP` / `AGREE & COMPLETE PAYMENT`
 *      specifically remain permanently off-limits to automation
 *      regardless of future evidence (see this file's own closing note
 *      below).
 *   6. The downloaded portrait's local temp file is ALWAYS cleaned up in
 *      a `finally`, whether any step above succeeds, throws, or anything
 *      later throws -- the attempt for THIS applicant is over either way,
 *      so the browser no longer needs that file once this call returns
 *      or throws, regardless of which branch was reached.
 *
 * Insurance consent (Page 5's single checkbox, confirmInsuranceConsent),
 * the Terms and Conditions checkbox (Page 6, confirmTermsAndConditions),
 * and Page 7's own SAVE / SAVE AND MOVE TO THE NEXT APPLICANT action ARE
 * now automatically confirmed/clicked by this file, per the operator's
 * own explicit, risk-disclosed authorization above. CAPTCHA, OTP, PAY FOR
 * GROUP, payment, and a Legal Declaration DISTINCT from Page 6's own
 * terms checkbox (never confirmed either way) are never automatically
 * confirmed anywhere in this file, directly or indirectly -- PAY FOR
 * GROUP and AGREE & COMPLETE PAYMENT specifically may NEVER be added to
 * this file's automated flow, regardless of future evidence or
 * instruction, since they trigger an actual, irreversible real-money
 * charge rather than a per-applicant fee acknowledgment.
 */

/**
 * Pure decision logic, extracted so it is directly testable independent
 * of the rest of this file. Mirrors this project's own approved workflow
 * decision: every applicant except the batch's last one uses
 * "Save & Add Applicant"; the last one uses plain "Save" -- see
 * clickSave/clickSaveAndMoveToNextApplicant's own doc comments
 * (visitSaudiPageActions.ts) for the real, confirmed text each one
 * clicks.
 *
 * Page7 SAVE FIX: now called for real by submitApplicant below, once
 * Page 7 ("Review Application") is reached and its own expected action is
 * confirmed visible -- see this file's own top doc comment, step 5.
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

        // Page3->Page7 flow fix (this package): SAVE / SAVE AND MOVE TO
        // THE NEXT APPLICANT is NEVER clicked here -- see this file's own
        // top doc comment for why (the real continue action belongs on
        // Page 7, not Page 3, and this adapter does not yet reach Page
        // 7). Page 3 is now genuinely complete.
        const detailParts: string[] = [];

        // Page3->Page4 trigger fix (this package): clicks Page 3's own
        // forward action, reusing clickNext -- the SAME generic,
        // already-confirmed-for-Page-4 matcher (visitSaudiPageActions.ts's
        // own doc comment), never a newly-invented selector. Grounded in
        // the operator's OWN real-portal observation (confirmed Page 3
        // shows "UPLOAD FILE" and optional fields left blank, then "Next"
        // advances) -- not an independently re-verified screenshot crop
        // like Page 4's own Next button got, so a failure to find/click
        // it here is a genuine, reported uncertainty, never silently
        // guessed as having advanced.
        let page3NextClicked = true;
        try {
          await clickNext(page);
        } catch {
          page3NextClicked = false;
        }

        if (!page3NextClicked) {
          detailParts.push(
            'Page 3 (personal info) filled and confirmed, but its own forward ("Next") action could not be found/clicked -- page state after Page 3 is unconfirmed; automation stops here without advancing',
          );
          return { outcome: 'AMBIGUOUS', detail: detailParts.join('; ') };
        }

        if (!(await isAnchorVisible(page, 'Passport Type'))) {
          // The Next click itself resolved, but Page 4's own confirmed
          // anchor never appeared afterward -- a genuine, unresolved
          // uncertainty (something was clicked and did not produce the
          // expected result), never a known handoff, so this is AMBIGUOUS.
          detailParts.push(
            'Page 3\'s forward action was clicked, but Page 4 ("Passport Type") never became visible afterward -- portal page state is unconfirmed',
          );
          return { outcome: 'AMBIGUOUS', detail: detailParts.join('; ') };
        }

        // Page 4 unexpectedly became visible without this adapter ever
        // clicking anything to get there -- filled for real regardless,
        // same evidence-backed field-filling as before this package.
        const tripDetailsResult = await fillApplicantTripDetailsFields(page, {
          draft: input.draft,
          countryOfBirth: input.countryOfBirth,
          expectedDateOfArrival: input.expectedDateOfArrival,
          expectedDateOfDeparture: input.expectedDateOfDeparture,
        });

        if (!tripDetailsResult.advancedToNextPage) {
          // This project's own updated rule: an unconfirmed hotel
          // selection must never advance past Page 4 -- see
          // fillApplicantTripDetailsFields's own doc comment. This is a
          // genuine, unresolved uncertainty (not a known handoff), so it
          // is reported AMBIGUOUS, unchanged from before this package.
          detailParts.push(
            'hotel autocomplete suggestion was not found/selected -- stopped on Page 4 without advancing, per this project\'s own rule that an unconfirmed hotel selection must never proceed to the next step',
          );
          return { outcome: 'AMBIGUOUS', detail: detailParts.join('; ') };
        }

        // Page 4's confirmed Next button was clicked for real, but
        // whether that actually reveals Page 5 (Insurance) has never
        // been confirmed. This safe page-check never assumes either
        // outcome -- and NEITHER outcome is left silent.
        if (await isAnchorVisible(page, 'INSURANCE COVERAGE')) {
          // Page5->Page6 TRIGGER FIX (this package): explicitly authorized
          // by the operator -- twice, with the fact that this checkbox is
          // actually a per-applicant fee-acceptance (confirmInsuranceConsent's
          // own doc comment: "...with a fee of ... SAR") disclosed and
          // acknowledged both times -- to automatically confirm insurance
          // consent and advance, rather than stopping for a human to do it.
          // Reuses confirmInsuranceConsent (its own real, evidence-backed
          // text match, immune to the fee amount varying between 65.00 and
          // 95.00 SAR) and the same generic clickNext already used for
          // Page3->4 and Page4->5. PAY FOR GROUP and AGREE & COMPLETE
          // PAYMENT remain never clicked anywhere in this file.
          let page5Advanced = true;
          try {
            await confirmInsuranceConsent(page);
            await clickNext(page);
          } catch {
            page5Advanced = false;
          }

          if (!page5Advanced) {
            detailParts.push(
              'Page 4 (Passport & Trip Details) filled and confirmed; Page 5 (Insurance) reached, but confirming insurance consent and/or clicking Next failed -- page state after Page 5 is unconfirmed; automation stops here without advancing',
            );
            return { outcome: 'AMBIGUOUS', detail: detailParts.join('; ') };
          }

          // Page6->Page7 TRIGGER FIX (this package): now that Page 6's own
          // confirmed anchor/consent checkbox exists (TERMS_AND_CONDITIONS_ANCHOR,
          // confirmTermsAndConditions), the same safe page-check pattern as
          // Page 4/Page 5 applies -- never assumed, never silently guessed.
          if (!(await isAnchorVisible(page, TERMS_AND_CONDITIONS_ANCHOR))) {
            detailParts.push(
              'Page 4 (Passport & Trip Details) and Page 5 (Insurance consent) both filled/confirmed and Next clicked, but Page 6 (Terms and Conditions) did not become visible afterward -- portal page state is unconfirmed',
            );
            return { outcome: 'AMBIGUOUS', detail: detailParts.join('; ') };
          }

          // confirmTermsAndConditions's own doc comment flags an OPEN GAP:
          // it is not confirmed whether Page 6 has other required
          // checkboxes beside this one (its real id, "chkSelectDeselectAll",
          // hints it might only be a "select/deselect all" control). Only
          // this one confirmed checkbox is ever clicked -- never a guessed
          // additional one. If that is insufficient on the real portal, the
          // Next click's actual effect is verified below, same as every
          // other step in this chain, never assumed.
          let page6Advanced = true;
          try {
            await confirmTermsAndConditions(page);
            await clickNext(page);
          } catch {
            page6Advanced = false;
          }

          if (!page6Advanced) {
            detailParts.push(
              'Page 4, Page 5 (Insurance) complete; Page 6 (Terms and Conditions) reached, but confirming the terms checkbox and/or clicking Next failed -- page state after Page 6 is unconfirmed; automation stops here without advancing',
            );
            return { outcome: 'AMBIGUOUS', detail: detailParts.join('; ') };
          }

          // Page7 SAVE FIX (this package): the operator's own real
          // Inspect-element capture now independently CONFIRMS both of
          // Page 7's own actions -- `<span> Save & Add Applicant</span>`
          // (applicants 1-9) and `<a id="aSave" href="/Visa/Save"
          // class="cta">...Save</a>` (applicant 10, the batch's last) --
          // matching this project's own earlier-approved business rule
          // (chooseSaveAction's own doc comment) for WHICH one to use. The
          // same real evidence also corrected clickSave/
          // clickSaveAndMoveToNextApplicant themselves, which had
          // previously matched an invented/assumed label that never
          // matched the real portal (see their own doc comments,
          // visitSaudiPageActions.ts). The arrival check below targets the
          // SPECIFIC action this applicant needs, not a generic Page 7
          // heading (never observed) -- this doubles as both the
          // page-reached confirmation and the pre-click safety check, same
          // convention as Page 6's own terms checkbox.
          // Checked with exact:true, unlike every other anchor in this
          // file: "Save" alone is short and generic enough to otherwise
          // false-match unrelated text elsewhere on the page (confirmed by
          // this project's own test suite, which caught exactly this
          // collision against a decoy button used by an unrelated test).
          const page7ActionAnchor = input.isLastApplicantInBatch ? 'Save' : 'Save & Add Applicant';
          if (!(await isAnchorVisible(page, page7ActionAnchor, 3000, true))) {
            detailParts.push(
              `Page 4, Page 5 (Insurance), and Page 6 (Terms and Conditions) all filled/confirmed and their own Next/consent actions clicked, but Page 7's own expected action ("${page7ActionAnchor}") never became visible -- portal page state is unconfirmed`,
            );
            return { outcome: 'AMBIGUOUS', detail: detailParts.join('; ') };
          }

          let page7Saved = true;
          try {
            await chooseSaveAction(input.isLastApplicantInBatch)(page);
          } catch {
            page7Saved = false;
          }

          if (!page7Saved) {
            detailParts.push(
              `Page 7 (Review Application) reached, but clicking its own expected action ("${page7ActionAnchor}") failed -- page state is unconfirmed; automation stops here without advancing`,
            );
            return { outcome: 'AMBIGUOUS', detail: detailParts.join('; ') };
          }

          // This project's own earlier-approved rule (confirmSaveOutcome's
          // own doc comment, visitSaudiPageActions.ts): a successful
          // (non-throwing) SAVE / SAVE AND MOVE TO THE NEXT APPLICANT
          // click IS the required, sufficient signal -- deliberately
          // without a further UI confirmation, since none has ever been
          // observed on the real portal. This is the ONLY path in this
          // file that reports SAVED.
          detailParts.push(
            `Page 3 through Page 6 all filled/confirmed, and Page 7's own expected action ("${page7ActionAnchor}") was clicked for real`,
          );
          return { outcome: 'SAVED', detail: detailParts.join('; ') };
        }

        detailParts.push('Page 5 (Insurance) did not appear after Page 4\'s Next click -- portal page state unconfirmed');
        return { outcome: 'AMBIGUOUS', detail: detailParts.join('; ') };
      } finally {
        await cleanupDownloadedTempFile(portraitPath);
      }
    },
  };
}
