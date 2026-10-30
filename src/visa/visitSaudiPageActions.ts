import type { Page } from 'playwright';
import { downloadUrlToTempFile } from './downloadUrlToTempFile.js';
import type { VisitSaudiApplicationDraft } from './types.js';
import type { MaritalStatusForVisitSaudi } from './computeMaritalStatusForVisitSaudi.js';
import type { ProfessionForVisitSaudi } from './genderProfessionMap.js';
import { mapGenderToVisitSaudiOption } from './genderOptionMap.js';

/**
 * ============================================================================
 * Package 5.26 -- VisitSaudi portal page actions, EVIDENCE-SCOPED ONLY
 * ============================================================================
 * Every function below targets a UI element whose VISIBLE TEXT the user has
 * explicitly confirmed, via recovered screenshot evidence (Package 5.26's
 * own report quotes each one verbatim). Locators here use Playwright's
 * text-based matching (`getByText`), never an invented CSS selector, id, or
 * class name -- none of those have ever been observed. This is also the
 * more robust Playwright convention: visible text survives a markup/CSS
 * refactor that would break a brittle selector.
 *
 * Package 5.36: every Page 3 field (the applicant personal-info form,
 * including the on-behalf question, Gender, Marital Status, and Date of
 * Birth) is now implemented from recovered real-portal evidence. Only
 * `confirmSaveOutcome` remains deliberately un-implemented (see its own
 * doc comment below) -- no evidence exists for a save-confirmation
 * signal, and Package 5.31's approved business rule makes it unused by
 * the real adapter's default flow regardless.
 *
 * CAPTCHA, OTP, PAY FOR GROUP, payment, and the legal declaration are, by
 * design, never targeted by any function in this file, and no future
 * function here may target them either -- see visaApplicantAutomationAdapter.ts's
 * own doc comment for why.
 */

/**
 * Page 1 (post-login "Apply for eVisa" dashboard): the `APPLY FOR GROUP`
 * button/link -- exact text confirmed by the user's recovered evidence.
 * Uses getByText rather than getByRole('button'/'link') because the exact
 * underlying element type (<button> vs <a> vs a clickable <div>) was not
 * observed; Playwright's text locator resolves to whichever element
 * actually carries this text and dispatches a real click event on it.
 */
export async function clickApplyForGroup(page: Page): Promise<void> {
  await page.getByText('APPLY FOR GROUP', { exact: true }).click();
}

/**
 * Page 2 (group creation): the required `Group Name*` field -- exact label
 * confirmed. Matched case-sensitively but WITHOUT requiring the trailing
 * `*` as part of the match (a "required field" marker is often rendered by
 * separate CSS/markup, not always part of the <label> element's own text
 * content) -- `exact: false` with the base label text handles either case
 * without guessing which one the real page actually does.
 */
export async function enterGroupName(page: Page, groupName: string): Promise<void> {
  await page.getByLabel('Group Name', { exact: false }).fill(groupName);
}

/**
 * Page 2: the teal `+` button that confirms group creation. LOWER
 * CONFIDENCE than every other function in this file -- the character `+`
 * is confirmed from the user's evidence, but a bare "+" is a common,
 * non-unique symbol (add-row, zoom, expand, ...) and nothing is known
 * about this button's surrounding context, uniqueness on the page, or
 * accessible name beyond its visible glyph. If this locator ever matches
 * more than one element (Playwright's strict mode throws rather than
 * picking one silently), that failure itself is useful signal -- treat it
 * as a sign this specific function needs tighter scoping (e.g. restricting
 * to a form/container near the Group Name field) once the real page is
 * actually seen, not as a bug to silently work around.
 */
export async function confirmGroupCreation(page: Page): Promise<void> {
  await page.getByText('+', { exact: true }).click();
}

/**
 * Package 5.27: the cohesive Page 1 -> Page 2 group-creation workflow,
 * composed entirely from the three evidence-verified actions above --
 * nothing new is invented here, only chained. `groupName` is the caller's
 * responsibility to supply; this function reuses whatever the caller
 * passes rather than formatting one itself, so the EXISTING, ALREADY-
 * TESTED buildVisaBatchName.ts (assignVisaBatch.ts's own batch-naming
 * logic, e.g. "26.10-1") stays the single source of truth for this
 * format -- never duplicated here. A real caller is expected to pass
 * `batch.batchName` (VisaBatch's own already-computed field) directly.
 *
 * This project's own updated rule: a resolved (non-throwing) click on the
 * `+` button is NOT, by itself, trusted as proof the group was actually
 * created -- confirmGroupCreation's own doc comment already flags that
 * bare "+" as a lower-confidence, non-unique locator. After clicking it,
 * this function waits for Page 3's own confirmed anchor ("UPLOAD FILE" --
 * see uploadApplicantPortrait above, the same evidence-verified text used
 * to drive the per-applicant portrait upload) to become visible. If it
 * never appears within the bounded timeout, group creation is treated as
 * UNCONFIRMED and this throws a clear, named error -- the caller
 * (startVisitSaudiBatchSubmission.ts) propagates this uncaught, so no
 * batch lock is ever acquired and no applicant is ever claimed against a
 * group that was never actually created. This can never falsely report a
 * failure as success, only the reverse (treating a genuinely-created group
 * as unconfirmed, if "UPLOAD FILE" happens to render unusually slowly) --
 * the safe direction for this specific risk.
 */
export async function createVisitSaudiGroup(page: Page, groupName: string): Promise<void> {
  await clickApplyForGroup(page);
  await enterGroupName(page, groupName);
  await confirmGroupCreation(page);
  await ensureAnchorVisible(
    page,
    'UPLOAD FILE',
    'createVisitSaudiGroup: group creation could not be confirmed (expected Page 3 to appear after clicking "+")',
  );
}

/**
 * The `PREVIOUS` button -- exact text confirmed, originally from Page 3's
 * own evidence and RE-confirmed present, in the same exact ALL-CAPS
 * rendering, at the bottom of Page 4 ("Passport & Trip Details") by a
 * later recovered screenshot -- not page-specific.
 */
export async function clickPrevious(page: Page): Promise<void> {
  await page.getByText('PREVIOUS', { exact: true }).click();
}

/**
 * Page 4 ("Passport & Trip Details"): the pill-shaped `Next >` button
 * that advances to Page 5 -- confirmed present (alongside PREVIOUS) by a
 * closely-zoomed crop of the SAME recovered screenshot that confirmed
 * every other Page 4 field. That crop resolved two things this function's
 * EARLIER version (Package 5.26, before Page 4 was ever directly
 * observed) had only assumed: the visible label reads "Next" in Title
 * Case -- NOT this project's otherwise-consistent ALL-CAPS button
 * convention (SAVE, PREVIOUS, COMMERCIAL ACCOMMODATION, LEISURE, ...) --
 * and it is followed by a small chevron-like glyph whose own markup (a
 * literal ">" character vs. an icon font/SVG with no text content) could
 * not be determined from a screenshot alone.
 *
 * Matched via a regex ANCHORED TO THE START of the element's text,
 * case-insensitively ("next", nothing before it, anything or nothing
 * after it) -- this bridges BOTH confirmed-but-uncertain gaps (the
 * casing, and whatever renders after the word) without guessing either
 * one's exact representation. This remains safe, not an approximate/loose
 * match: nothing else on Page 4's own confirmed field list (Passport
 * Type/No./dates, Purpose, Communication Preference, Residence Address,
 * Hotel, Primary Contact Number, Email) starts with the word "next"
 * anywhere, so this can never resolve to an unrelated element. It is
 * deliberately NOT exact-matched (unlike PREVIOUS): requiring the
 * trailing glyph to match exactly would risk UNDER-matching (missing the
 * real button entirely) just as badly as guessing its exact
 * representation would risk over-matching the wrong one.
 */
export async function clickNext(page: Page): Promise<void> {
  await page.getByText(/^\s*next\b/i).click();
}

/**
 * Page 3: triggers the real `Upload File` control for the Personal
 * Picture field and supplies the given local file. Uses Playwright's
 * native `filechooser` event rather than locating the underlying <input
 * type="file"> directly -- this works correctly regardless of that
 * input's own selector, as long as clicking the confirmed `Upload File`
 * label opens a native OS file dialog, which is the normal behavior for
 * this kind of control and is what Playwright's filechooser event is
 * specifically designed to intercept.
 *
 * CORRECTED (real-run evidence): a real automated run against the real
 * portal timed out waiting for the filechooser event -- the earlier
 * ALL-CAPS "UPLOAD FILE" exact-text match (from a recovered screenshot,
 * same CSS-uppercase-vs-real-DOM-text mismatch already found and fixed
 * for the on-behalf Yes/No question) never matched the real label. The
 * operator's own real Inspect-element capture confirms the real markup:
 * `<label for="AttachmentPersonalPicture" class="cta my-4">Upload File
 * <span ...><svg>...</svg></span>*</label>` -- Title Case, AND the
 * label's own full text also includes a trailing "*" (required-field
 * marker) after the icon, so an exact match on "Upload File" alone would
 * still fail even after fixing the case. Matched with exact:false (this
 * file's own established convention for exactly this situation -- see
 * confirmInsuranceConsent's own prefix-only match for its own varying
 * trailing content) instead.
 */
export async function uploadApplicantPortrait(page: Page, localPortraitFilePath: string): Promise<void> {
  const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByText('Upload File', { exact: false }).click()]);
  await fileChooser.setFiles(localPortraitFilePath);

  // CROP STEP FIX (real-run evidence): selecting a file does NOT commit
  // it directly -- the real portal opens a "Crop Image" modal that must
  // be confirmed first. This was discovered because the OLD check here
  // (reading fileChooser.element()'s own <input>.files immediately after
  // setFiles()) genuinely failed on a real run -- it was checking the
  // wrong moment, before the crop step, not a real correctness problem
  // with that element reference itself. The operator's own real
  // Inspect-element capture confirms the real confirm button:
  // `<button class="rounded-button upload-result">Crop</button>`, and the
  // operator's own direct observation confirms both that the modal
  // closes after clicking it, and that a thumbnail + "foto" label then
  // appear where "Upload File" used to be alone.
  //
  // OPENLY FLAGGED, UNRESOLVED GAP: the crop tool's own zoom/position
  // slider defaults to maximum zoom, and the operator's own side-by-side
  // test proved the DEFAULT position produces a BADLY cropped face for
  // one source image (too tight, cutting off most of the face) while
  // working fine for a different, more wide-framed source image --
  // i.e., the correct slider position is source-image-dependent, not a
  // fixed constant. No real, evidence-based way to compute the right
  // position for an arbitrary portrait exists in this codebase, so this
  // function does NOT touch the slider -- it accepts the tool's own
  // default, same as it did before this fix was even found. A
  // poorly-framed crop is a real, silent quality risk this function
  // cannot detect or prevent (same category of gap as the Page 4 date
  // fields' own openly-flagged gap, fillApplicantPersonalInfoFields's own
  // doc comment) -- an operator should verify portrait framing for any
  // batch run through this path until a real, evidence-backed fix for
  // the slider exists.
  await page.getByText('Crop Image', { exact: false }).waitFor({ state: 'visible', timeout: 10000 });
  await page.getByText('Crop', { exact: true }).click();

  // The modal closing is the one real, confirmed signal that the crop
  // action was accepted without erroring -- it does NOT, and cannot,
  // confirm the crop's own visual quality, nor that the real portal's
  // own SERVER accepted the upload; no such signal has ever been
  // observed on the real VisitSaudi portal.
  await page.getByText('Crop Image', { exact: false }).waitFor({ state: 'hidden', timeout: 10000 });
}

/**
 * Package 5.27: reuses the EXISTING applicant data pipeline directly --
 * `personalPortraitUrl` (VisitSaudiApplicationDraft, types.ts, already
 * produced by buildVisaApplicationDraft.ts/visitSaudiPreflight.ts) is
 * downloaded via downloadUrlToTempFile.ts, then fed into
 * uploadApplicantPortrait above.
 *
 * Returns the downloaded file's own local path -- deliberately does NOT
 * delete it itself. This is a real, empirically-confirmed correctness
 * fix, not caution for its own sake: an earlier version of this function
 * cleaned the file up immediately after setFiles() resolved, and a test
 * written for exactly that behavior (see this file's own test) caught
 * the uploaded File's reported `size` coming back as 0 once the
 * underlying disk file was gone -- Chromium (via Playwright's CDP-based
 * setFiles) appears to read a disk-backed File's bytes LAZILY, not
 * necessarily by the time setFiles() itself resolves. Deleting the file
 * at that point risks the browser later submitting an EMPTY portrait on
 * the real portal -- a silent, serious failure on a real visa
 * application, not a cosmetic one. The caller is responsible for
 * deleting the returned path (via cleanupDownloadedTempFile) only once
 * it is certain the browser no longer needs it -- e.g. after the
 * applicant's own SAVE / SAVE AND MOVE TO THE NEXT APPLICANT action has
 * fully completed, never immediately after upload.
 */
export async function uploadApplicantPortraitFromUrl(page: Page, personalPortraitUrl: string): Promise<string> {
  const localPath = await downloadUrlToTempFile(personalPortraitUrl, 'personal-portrait.jpg');
  await uploadApplicantPortrait(page, localPath);
  return localPath;
}

/**
 * Page 7 ("Review Application")'s own "add another applicant" action
 * (applicants 1-9 of 10) -- CORRECTED from this file's own earlier
 * version, which used an invented/assumed label
 * ("SAVE AND MOVE TO THE NEXT APPLICANT", this project's own earlier
 * approved-workflow-decision text, never independently verified against
 * the real portal). The operator's own real Inspect-element capture shows
 * the real markup is `<span> Save &amp; Add Applicant</span>`, so this is
 * now matched on that real, confirmed text instead. Exact-matched so it
 * can never accidentally also match the batch's-last-applicant action
 * below (a DIFFERENT, shorter confirmed string, "Save", which happens to
 * also be a substring of this one).
 */
export async function clickSaveAndMoveToNextApplicant(page: Page): Promise<void> {
  await page.getByText('Save & Add Applicant', { exact: true }).click();
}

/**
 * Page 7's own final-applicant action (applicant 10 of 10, the batch's
 * last one) -- CORRECTED from this file's own earlier version, which
 * matched an invented/assumed ALL-CAPS "SAVE" (never independently
 * verified; Playwright's exact match is case-sensitive, so it would never
 * have matched the real button at all). The operator's own real
 * Inspect-element capture shows the real markup is
 * `<a id="aSave" href="/Visa/Save" class="cta">...<svg aria-hidden="true">...</svg>Save</a>`
 * -- mixed-case "Save", confirmed via its own real `id` too. Matched on
 * text (this file's own established convention throughout, resilient to
 * `id`/class churn) rather than the `id`, with the confirmed `id` kept
 * here only as corroborating evidence, not as the selector itself.
 * Deliberately exact-matched so it can never accidentally also match
 * `Save & Add Applicant` above (which also contains the substring
 * "Save").
 */
export async function clickSave(page: Page): Promise<void> {
  await page.getByText('Save', { exact: true }).click();
}

// ============================================================================
// Package 5.36: answerApplyingOnBehalfOfSomeoneElse and
// fillApplicantPersonalInfoFields below are now REAL implementations
// (see their own doc comments for the exact recovered evidence each
// relies on). confirmSaveOutcome remains the one deliberately
// un-implemented function in this file.
// ============================================================================

/**
 * Package 5.32: the required answer to Page 3's `Are you applying on
 * behalf of someone else?` question, per this project's own earlier
 * approved-rules audit ("TASDIQLANGAN VISITSAUDI QOIDALARI" / "APPROVED
 * VisitSaudi RULES" -- a prior READ-ONLY audit package in this same
 * engagement, recovered from this session's own history rather than
 * re-asked for): `"Are you applying on behalf of someone else?" = Yes`.
 * This resolves HALF of this function's own blocker below -- the
 * business answer is no longer unverified. It does not resolve the other
 * half (the widget's shape), and must never be used to guess that.
 */
export const CONFIRMED_APPLYING_ON_BEHALF_OF_SOMEONE_ELSE_ANSWER = 'YES' as const;

/**
 * CORRECTED (real-run evidence): a recovered real-portal SCREENSHOT had
 * suggested the visible text reads ALL-CAPS "YES"/"NO" -- but a
 * screenshot cannot distinguish real DOM text from CSS-driven visual
 * uppercasing (text-transform), and the former is what Playwright's
 * text locator actually matches. A real automated run against the real
 * portal timed out waiting for exact-text "YES" (Playwright's exact
 * match is case-sensitive), which is exactly this mismatch surfacing.
 * The operator's own real Inspect-element capture confirms the actual
 * markup is Title Case: `<label for="ApplyingVisaForSomeoneElseYes"
 * class="radio-custom-label copy">Yes</label>` (id corroborates, but
 * text remains the selector, same established convention as
 * clickSave). DOM_LABEL_FOR_ON_BEHALF_ANSWER maps the business-level
 * 'YES'/'NO' answer (CONFIRMED_APPLYING_ON_BEHALF_OF_SOMEONE_ELSE_ANSWER,
 * unchanged) to the real, confirmed DOM text -- nothing about the
 * business answer itself changes, only how it is matched on screen.
 *
 * SECOND real-run finding: a page-wide exact-text search for "Yes" hit a
 * Playwright strict-mode violation (correctly refusing to click either
 * one rather than guessing) -- the real page ALSO has an unrelated
 * `<button id="btnExtend" ...>Yes</button>` elsewhere. Playwright's own
 * error output named the fix: the real "applying on behalf" label lives
 * inside `#formPersonalInfo` (confirmed by that same error's own
 * `locator('#formPersonalInfo').getByText('Yes')` resolution hint, not
 * invented), so the search is scoped to that real, confirmed container,
 * never page-wide.
 */
const DOM_LABEL_FOR_ON_BEHALF_ANSWER: Record<'YES' | 'NO', string> = { YES: 'Yes', NO: 'No' };

export async function answerApplyingOnBehalfOfSomeoneElse(page: Page, answer: 'YES' | 'NO'): Promise<void> {
  await page.locator('#formPersonalInfo').getByText(DOM_LABEL_FOR_ON_BEHALF_ANSWER[answer], { exact: true }).click();
}

/**
 * Package 5.33: confirmed business-rule VALUES, from this project's own
 * earlier approved-rules audit ("TASDIQLANGAN VISITSAUDI QOIDALARI"),
 * reproduced exactly -- nothing inferred, rounded, or guessed. Every
 * value here is a FIXED constant, true for every applicant regardless of
 * their own Sheet/DB data (unlike e.g. countryOfBirth, which depends on
 * `nationality` and is already computed by visitSaudiPreflight.ts).
 *
 * Deliberately NOT a selector, a locator, or a page interaction, and NOT
 * wired into VisitSaudiReadyApplicant -- none of these values has ever
 * been placed, by any observed screenshot, label, or page order, onto
 * Page 3 or any other specific step of the real multi-page application.
 * This is pure, reusable DATA: exported so a future package with real
 * label evidence for whichever page each of these turns out to live on
 * can read the confirmed value directly from here, instead of
 * re-deriving it from a transcript search. Using one of these values to
 * fill an UNCONFIRMED field/page would still be guessing; this constant
 * only removes the "what does the business want here" half of that
 * guess, never the "where/how does the real page expose it" half.
 *
 * (Passport Issue Place is deliberately NOT included here: the evidence
 * defines it as "the same country as nationality/passport," i.e. a
 * per-applicant DERIVED value, not a flat constant -- it would reuse
 * countryCapitalLookup.ts's own `country` result, exactly like
 * countryOfBirth/countryOfResidence already do, if and when a page ever
 * needs it.)
 */
export const CONFIRMED_VISIT_SAUDI_FORM_VALUES = {
  passportType: 'Regular Passport',
  /**
   * This project's own updated rule: ONLY `UMRAH` is selected. `LEISURE`
   * is never clicked or selected. Earlier packages clicked BOTH UMRAH and
   * LEISURE in sequence, assuming a multi-select checkbox group -- but no
   * evidence anywhere in this codebase ever confirmed that assumption
   * (the real widget's type -- radio vs. checkbox -- was never observed),
   * and clicking two options on what might be a single-select (radio)
   * widget would leave only the LAST one clicked actually selected,
   * silently discarding the first click. A single, explicit value removes
   * that ambiguity entirely, regardless of which widget type the real
   * portal turns out to use.
   */
  purpose: 'UMRAH',
  alternateEmailAnswer: 'No',
  alternatePhoneAnswer: 'No',
  hotelName: 'EMAAR ELITE HOTEL MAKKA',
  currentResidenceAddress: 'TASHKENT CITY',
} as const;

export interface VisitSaudiPersonalInfoFieldsInput {
  draft: VisitSaudiApplicationDraft;
  maritalStatus: MaritalStatusForVisitSaudi;
  countryOfBirth: string;
  cityOfBirth: string;
  countryOfResidence: string;
  cityOfResidence: string;
  profession: ProfessionForVisitSaudi;
}

/**
 * A real <select>'s own <option> text, matched case-INSENSITIVELY --
 * never a CSS/attribute selector built from the expected value. This
 * exists because a recovered screenshot shows the real "Country of
 * Nationality" dropdown displaying "Uzbekistan" (Title Case), while this
 * codebase's own existing, already-tested countryCapitalLookup.ts
 * produces "UZBEKISTAN" (its confirmed, uppercase, internal
 * convention) -- the SAME country, a confirmed, already-known casing
 * difference, not an unknown value. Normalizing case to bridge that is
 * not guessing; if no option's text matches even case-insensitively,
 * this throws a clear, named error rather than selecting the wrong
 * thing or silently doing nothing. Only ever used on a real <select>
 * (via .locator('option')) -- if the real control turns out to be a
 * custom, non-<select> widget, `optionLocator.count()` simply resolves
 * to 0 and this throws immediately, which is the correct, safe outcome.
 */
async function selectDropdownOptionCaseInsensitive(select: ReturnType<Page['getByLabel']>, expectedText: string): Promise<void> {
  const optionLocator = select.locator('option');
  const count = await optionLocator.count();
  const normalizedExpected = expectedText.trim().toLowerCase();
  for (let i = 0; i < count; i += 1) {
    const optionText = (await optionLocator.nth(i).textContent())?.trim() ?? '';
    if (optionText.toLowerCase() === normalizedExpected) {
      await select.selectOption({ index: i });
      return;
    }
  }
  throw new Error(
    `selectDropdownOptionCaseInsensitive: no <option> matching "${expectedText}" (case-insensitive) was found among ${count} option(s)`,
  );
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const CALENDAR_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
const CALENDAR_MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * CALENDAR WIDGET FIX (real-run evidence): `.fill()` on `Date of Birth`
 * timed out on a real run -- Playwright's own error log shows WHY, the
 * real `<input>` carries `readonly="readonly"` (confirmed, not a guess):
 * `<input ... id="DateOfBirth" name="DateOfBirth" readonly="readonly"
 * ... class="copy-01 datepicker1 disablePaste is-datepick" .../>`.
 * The operator's own real Inspect-element capture of the OPENED calendar
 * confirms a jQuery "datepick"-family widget with two real
 * `<select class="datepick-month-year" title="Change the month"|"Change
 * the year">` dropdowns (option VALUES encode "month/year" together, but
 * option LABELS are plain month names / bare years, e.g. `<option
 * value="10/1966">1966</option>`, `<option value="9/2026"
 * selected>September</option>`) and day cells as `<a href="javascript:void(0)"
 * class="dp<unique-per-day>" title="Select Friday, Oct 16, 2026">16</a>`
 * -- the day `<a>`'s own class is NOT a stable selector (regenerated per
 * day), but its `title` attribute's "{MonAbbrev} {day}, {year}" suffix
 * is stable and is built directly from the same ISO date this function
 * is given, reformatted with a month abbreviation.
 *
 * Opens the widget by clicking the real field directly by its confirmed
 * `id` (confirmed clickable: `style="cursor: pointer;"`) -- NOT by
 * `getByLabel`: a real automated run proved that association unreliable
 * for Page 4's own date fields (the click itself resolved without
 * throwing, but the calendar never appeared -- getByLabel's own
 * accessible-name matching was never independently confirmed for these
 * fields, unlike the real, operator-captured `id` each one carries).
 * Selects the year by its OPTION LABEL (never the value string, which
 * depends on whatever month happens to be currently selected), then the
 * month the same way, then clicks the day `<a>` matching the confirmed
 * title-suffix pattern. The month/year selects and day links are scoped
 * to whichever such elements are currently VISIBLE, not a guessed
 * container id -- at most one calendar instance is ever open at a time.
 *
 * Real, operator-confirmed `id`s for every one of this file's own five
 * date fields: `DateOfBirth`, `PassportIssueDate`, `PassportExpiryDate`,
 * `ExpectedDateOfEntry` (Expected Date of Arrival), `ExpectedDateOfLeave`
 * (Expected Date of Departure) -- all five independently confirmed to
 * carry the SAME `is-datepick` widget class and the SAME real calendar
 * markup (month/year `<select class="datepick-month-year">`, day `<a>`
 * with the same title pattern) via the operator's own Inspect-element
 * capture of each, not inferred from Date of Birth alone.
 */
async function selectDateFromCalendarWidget(page: Page, fieldId: string, isoDate: string): Promise<void> {
  const match = ISO_DATE_PATTERN.exec(isoDate);
  if (!match) {
    throw new Error(`selectDateFromCalendarWidget: "${isoDate}" is not a valid ISO (YYYY-MM-DD) date`);
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const day = Number(dayStr);

  await page.locator(`#${fieldId}`).click();
  await page.locator('select.datepick-month-year[title="Change the year"]').selectOption({ label: String(year) });
  await page.locator('select.datepick-month-year[title="Change the month"]').selectOption({ label: CALENDAR_MONTH_NAMES[monthIndex] });
  await page.locator(`a[title*="${CALENDAR_MONTH_ABBREVIATIONS[monthIndex]} ${day}, ${year}"]`).click();
}

/**
 * ============================================================================
 * Package 5.36 -- Page 3's personal-info fields, implemented from a
 * recovered real-portal screenshot (found in this session's own raw
 * history; every label below is copied verbatim from it, nothing
 * inferred from a category name).
 * ============================================================================
 *
 * Fields filled, in the real page's own visual order:
 *   - `Country of Nationality*` (dropdown) -- case-insensitive match
 *     against countryOfBirth (the SAME country as nationality, by this
 *     project's own approved rule and countryCapitalLookup.ts's own
 *     construction -- never re-derived separately).
 *   - `First Name or Given Name (English)*` / `Last Name or Family Name
 *     (English)*` (text) -- from the existing draft, unchanged.
 *   - `Father Name or Middle Name (English)` -- SKIPPED: the screenshot
 *     itself marks it "(Optional, if available in passport)", and this
 *     project's own approved rule says to leave optional fields alone.
 *   - `Country of Birth*` (dropdown, case-insensitive) / `City of
 *     Birth*` (text) -- from the existing, already-computed preflight
 *     values, unchanged.
 *   - `Profession*` -- a TEXT field (confirmed from the screenshot, NOT
 *     a dropdown), filled from the existing, already-computed value.
 *   - Under the `Current Residence Address` heading: `Country*`
 *     (dropdown, case-insensitive, countryOfResidence) / `City*` (text,
 *     cityOfResidence) / `Address*` (text, the approved fixed constant
 *     CONFIRMED_VISIT_SAUDI_FORM_VALUES.currentResidenceAddress =
 *     "TASHKENT CITY"). Matched with an ANCHORED regex (`/^Country\*?$/`
 *     etc.) rather than a plain string, specifically because the
 *     screenshot shows these as their own short labels, distinct from
 *     "Country of Birth"/"City of Birth" elsewhere on the same page --
 *     `exact:false` would ambiguously match BOTH (a real risk: "Country"
 *     is a substring of "Country of Birth"), while `exact:true` would
 *     require knowing whether the real page renders the trailing `*` as
 *     part of the label's own text or as separate markup (this project's
 *     own established convention -- see enterGroupName's doc comment --
 *     is that it's often separate, but that was never confirmed for
 *     THIS page). The anchored regex matches "Country" or "Country*"
 *     and nothing else, correctly handling either case without guessing
 *     which one the real page does, and still throws (never guesses)
 *     if neither matches.
 *   - `Zip/Postal Code` -- SKIPPED: the screenshot shows no asterisk
 *     (optional), and this project's own approved rule says to leave
 *     optional fields alone.
 *   - `Gender*` (dropdown) -- a SECOND recovered screenshot (the same
 *     real application, now with data FILLED IN rather than the empty
 *     form) shows this dropdown's own SELECTED value, not just its
 *     closed "Select" placeholder: `"Male"`. Filled via
 *     genderOptionMap.ts's new mapGenderToVisitSaudiOption, which maps
 *     the Sheet's own raw Uzbek gender label ("Erkak"/"Ayol") to that
 *     confirmed English option text -- throws (never guesses) for any
 *     other input, mirroring genderProfessionMap.ts's own established
 *     discipline for the exact same Sheet value.
 *   - `Marital Status*` (dropdown) -- the SAME filled-in screenshot
 *     shows `"Married"` as the selected value. maritalStatus
 *     ('SINGLE'/'MARRIED', already computed by
 *     computeMaritalStatusForVisitSaudi.ts) is Title-Cased to match
 *     ("Single"/"Married") -- a direct, lossless rendering of an
 *     already-known two-value enum, not a guess.
 *   - `Date of Birth *` -- CORRECTED (real-run evidence): a real
 *     automated run proved the earlier `.fill()` assumption wrong -- the
 *     real field is `readonly`, requiring the real calendar widget
 *     (selectDateFromCalendarWidget, this file's own doc comment above
 *     has the full real evidence: confirmed `readonly` input, confirmed
 *     month/year `<select>` dropdowns, confirmed day `<a>` title
 *     pattern).
 */
export async function fillApplicantPersonalInfoFields(page: Page, input: VisitSaudiPersonalInfoFieldsInput): Promise<void> {
  await selectDropdownOptionCaseInsensitive(page.getByLabel('Country of Nationality', { exact: false }), input.countryOfBirth);
  await page.getByLabel('First Name or Given Name (English)', { exact: false }).fill(input.draft.firstName);
  await page.getByLabel('Last Name or Family Name (English)', { exact: false }).fill(input.draft.surname);

  const genderMapResult = mapGenderToVisitSaudiOption(input.draft.gender);
  if (!genderMapResult.ok) {
    throw new Error(`fillApplicantPersonalInfoFields: cannot map gender "${input.draft.gender}" to a confirmed VisitSaudi Gender option -- never guessed.`);
  }
  await selectDropdownOptionCaseInsensitive(page.getByLabel('Gender', { exact: false }), genderMapResult.genderOption);

  const maritalStatusOption = input.maritalStatus === 'SINGLE' ? 'Single' : 'Married';
  await selectDropdownOptionCaseInsensitive(page.getByLabel('Marital Status', { exact: false }), maritalStatusOption);

  await selectDateFromCalendarWidget(page, 'DateOfBirth', input.draft.dateOfBirth);

  await selectDropdownOptionCaseInsensitive(page.getByLabel('Country of Birth', { exact: false }), input.countryOfBirth);
  await page.getByLabel('City of Birth', { exact: false }).fill(input.cityOfBirth);
  await page.getByLabel('Profession', { exact: false }).fill(input.profession);

  await selectDropdownOptionCaseInsensitive(page.getByLabel(/^Country\*?$/), input.countryOfResidence);
  await page.getByLabel(/^City\*?$/).fill(input.cityOfResidence);
  await page.getByLabel(/^Address\*?$/).fill(CONFIRMED_VISIT_SAUDI_FORM_VALUES.currentResidenceAddress);
}

/**
 * Waits briefly for `anchorText` to be visible, as a PAGE GUARD -- the
 * caller is responsible for already being on the right page (same
 * convention as every other function in this file), but the functions
 * below each check for one of their own page's confirmed, stable labels
 * FIRST, so a navigation-order mistake (landing on the wrong page, or a
 * page that never appeared) throws ONE clear, specific error naming what
 * was expected, rather than cascading into confusing per-field timeouts
 * or -- worse -- silently matching some unrelated element elsewhere on
 * whatever page actually loaded.
 */
async function ensureAnchorVisible(page: Page, anchorText: string, pageDescription: string, timeoutMs = 3000): Promise<void> {
  try {
    await page.getByText(anchorText, { exact: false }).first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new Error(
      `${pageDescription}: expected to find "${anchorText}" on the current page, but it was not visible within ${timeoutMs}ms. ` +
        'Never guessing navigation -- the caller must ensure the correct page is already open before calling this function.',
    );
  }
}

/**
 * Package 5.38 -- the non-throwing counterpart to ensureAnchorVisible,
 * for the one place in this file's own callers where "the next page did
 * not appear" is NOT necessarily an error: the real per-applicant
 * navigation after SAVE / SAVE AND MOVE TO THE NEXT APPLICANT (relative
 * to Pages 4/5) has never been confirmed (see
 * visitSaudiBrowserAutomationAdapter.ts's own doc comment for the full
 * reasoning). Returns whether `anchorText` became visible within
 * `timeoutMs` -- never throws, so a caller can safely branch on the
 * result instead of guessing which outcome to expect.
 *
 * `exact` defaults to false (substring, this file's own established
 * convention for multi-word anchors unlikely to collide, e.g.
 * "INSURANCE COVERAGE"). Pass `exact: true` for a short, generic anchor
 * (e.g. Page 7's own "Save") that COULD otherwise false-match unrelated
 * text elsewhere on the page -- confirmed necessary by this project's own
 * test suite, which caught exactly this collision against a leftover
 * decoy "SAVE" button.
 */
export async function isAnchorVisible(page: Page, anchorText: string, timeoutMs = 3000, exact = false): Promise<boolean> {
  try {
    await page.getByText(anchorText, { exact }).first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Package 5.38 -- Page 4's `Communication Preference *` section asks TWO
 * structurally identical-looking questions in a row, both confirmed from
 * the SAME recovered screenshot that confirmed every other Page 4 field:
 * "Do you want to receive the visa on a email other than your original
 * email?" (FIRST, its own YES/NO radio pair), then "Do you want to
 * receive the visa on a phone number other than your original phone
 * number?" (SECOND, its own YES/NO radio pair). BOTH questions always
 * render BOTH a YES and a NO button -- a radio pair, both options always
 * present regardless of which is currently selected -- so
 * `getByText('YES'|'NO', {exact:true})` always resolves to exactly TWO
 * elements each, in that confirmed document order. This is not a guess
 * about which pair is which: it is the confirmed page order itself. The
 * email question's own answer is always the FIRST (index 0) match of its
 * answer text; the phone question's own answer is always the SECOND
 * (index 1) match of its answer text -- true regardless of whether the
 * two answers happen to be the same text or different ones.
 */
export async function answerCommunicationPreference(page: Page, emailAnswer: 'YES' | 'NO', phoneAnswer: 'YES' | 'NO'): Promise<void> {
  await page.getByText(emailAnswer, { exact: true }).nth(0).click();
  await page.getByText(phoneAnswer, { exact: true }).nth(1).click();
}

/** Escapes every regex metacharacter in `text`, so it can be embedded literally inside a dynamically-built RegExp -- standard JS regex hygiene, not anything portal-specific. */
function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a case-insensitive RegExp matching any text that contains EVERY
 * word of `text`, in ANY order, anywhere within it -- via a chain of
 * lookaheads, a standard, well-documented JS regex technique (not
 * anything invented about this portal). Used to recognize a real
 * autocomplete suggestion whose own rendered text is a LONGER, DIFFERENT
 * string than what was typed (confirmed by a recovered screenshot: typing
 * "EMAAR ELITE HOTEL MAKKA" produced a selected value of "Emaar Elite
 * Hotel, Ajyad Street, Makkah" -- not a literal substring match of the
 * typed string, but one that DOES contain every one of its own
 * significant words).
 */
function buildContainsAllWordsPattern(text: string): RegExp {
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  const lookaheads = words.map((word) => `(?=.*${escapeRegExpLiteral(word)})`).join('');
  return new RegExp(`${lookaheads}.+`, 'is');
}

/**
 * ============================================================================
 * Package 5.39 -- a GENERAL, best-effort attempt to select a real
 * autocomplete suggestion for the Hotel field, generalized to any given
 * `expectedHotelName` (never hardcoded to one specific hotel).
 * ============================================================================
 *
 * WHY this is safe despite the suggestion dropdown's own DOM structure
 * never having been directly observed: this function never invents a
 * selector for "the dropdown" or "an option" at all. It instead reuses
 * this file's own established, already-proven idiom -- matching by
 * VISIBLE TEXT (getByText, exactly like clickApplyForGroup, clickSave,
 * answerCommunicationPreference, and every other function in this file)
 * -- generalized with buildContainsAllWordsPattern (above) so it still
 * matches the REAL suggestion's own longer, address-qualified text (see
 * that function's own doc comment). Because the ONLY thing ever clicked
 * is an element whose OWN TEXT already contains every word of the
 * EXPECTED hotel name, this can never select a DIFFERENT, wrong hotel --
 * the one thing that was never allowed to be guessed. The genuine
 * unknown this function cannot resolve -- whether the real widget even
 * renders a matchable, visible text node for its suggestions at all (a
 * canvas-rendered or closed-shadow-DOM widget would not) -- is handled
 * by simply not finding a match and returning false; the caller's
 * already-typed text is left exactly as it was, the SAME outcome as
 * every earlier package's behavior. This can therefore never make things
 * WORSE than before, only possibly better.
 *
 * `.pressSequentially` (real, per-keystroke input events), not `.fill`
 * (an instant value-set), is used to type the hotel name -- autocomplete
 * widgets commonly listen for keystroke-driven `input` events to trigger
 * their own suggestion fetch/render, which a single synthetic `.fill()`
 * may not reliably trigger. This is a standard, general Playwright
 * technique for working with autocomplete widgets, not a claim about
 * this specific portal's own implementation.
 *
 * Returns whether a suggestion was actually clicked, so a caller/test can
 * observe which branch happened without this function itself needing to
 * throw or guess which outcome is "correct" -- neither outcome is wrong.
 */
export async function fillHotelNameAndSelectSuggestion(page: Page, expectedHotelName: string, suggestionTimeoutMs = 2500): Promise<boolean> {
  const hotelInput = page.getByLabel('Name of Hotel', { exact: false });
  await hotelInput.pressSequentially(expectedHotelName, { delay: 20 });

  const suggestionPattern = buildContainsAllWordsPattern(expectedHotelName);
  const suggestion = page.getByText(suggestionPattern).first();
  try {
    await suggestion.waitFor({ state: 'visible', timeout: suggestionTimeoutMs });
  } catch {
    return false; // No matchable suggestion appeared -- the typed text is left exactly as-is, same as every earlier package's behavior.
  }
  await suggestion.click();
  return true;
}

export interface VisitSaudiTripDetailsFieldsInput {
  draft: VisitSaudiApplicationDraft;
  /** Same value as fillApplicantPersonalInfoFields's own countryOfBirth -- "Passport Issue Place" is the same country as nationality/passport, per this project's own approved rule (see CONFIRMED_VISIT_SAUDI_FORM_VALUES's own doc comment). */
  countryOfBirth: string;
  expectedDateOfArrival: string;
  expectedDateOfDeparture: string;
}

/**
 * ============================================================================
 * Package 5.37 -- the "Passport & Trip Details" page (reached after Page
 * 3; its own real navigation point relative to the per-applicant SAVE
 * click has never been confirmed -- see this function's own callers'
 * doc comments). Implemented from the SAME recovered real-portal
 * screenshot that confirmed Page 3's extra pages exist at all.
 * ============================================================================
 *
 * Filled, all evidence-backed:
 *   - `Passport Type*` (dropdown, case-insensitive) -- the approved
 *     constant "Regular Passport".
 *   - `Passport No.*` / `Passport Issue Place (Country or City)*` /
 *     `Passport Issue Date*` / `Passport Expiry Date*` / `Expected Date
 *     of Arrival*` / `Expected Date of Departure*` -- from the existing
 *     draft/preflight data, dates reformatted via the SAME confirmed
 *     DD/MM/YYYY pattern as Date of Birth (this page uses the identical
 *     date-input styling, same reasoning as fillApplicantPersonalInfoFields's
 *     own doc comment).
 *   - `Additional Purpose of Visit *` -- clicks ONLY `UMRAH` (never
 *     `SELECT ALL`, `EVENT`, `FAMILY & RELATIVES`, or `LEISURE`), per this
 *     project's own updated rule (see CONFIRMED_VISIT_SAUDI_FORM_VALUES's
 *     own doc comment for why LEISURE was removed). The real widget's
 *     type (radio vs. checkbox vs. something else) has never been
 *     observed -- a single click avoids needing to know, since it is the
 *     correct action either way.
 *   - `Residence Address in Saudi Arabia` -- `COMMERCIAL ACCOMMODATION`
 *     (a direct, confirmed consequence of being given a hotel name to
 *     fill at all; the screenshot shows the Hotel field appearing under
 *     exactly this choice).
 *   - `Name of Hotel*` (text) -- the approved constant "EMAAR ELITE
 *     HOTEL MAKKA".
 *   - `Email` (text, at the bottom of this page, separate from the
 *     Communication Preference's own conditional alternate-email field)
 *     -- filled from the applicant's own already-verified email
 *     (draft.email). Its exact purpose was never explicitly confirmed,
 *     but it is a plainly-labeled, generic contact field, and reusing
 *     already-known, already-verified applicant data for a plain
 *     "Email" field is not the same kind of guess as inventing a value.
 *
 * Package 5.38 -- two of the three previously-skipped items are now
 * RESOLVED, from a second recovered screenshot crop showing the real
 * page's exact structure (not just its empty/closed state):
 *   - `Communication Preference *`'s two YES/NO radio pairs -- the
 *     screenshot shows the email question's text directly above its own
 *     YES/NO pair, then the phone question's text directly above ITS OWN
 *     YES/NO pair, strictly in that order. answerCommunicationPreference
 *     (above) uses that confirmed document order to scope each click
 *     correctly (see its own doc comment) -- answered per
 *     CONFIRMED_VISIT_SAUDI_FORM_VALUES's own alternateEmailAnswer/
 *     alternatePhoneAnswer ("No"/"No").
 *   - `Primary Contact Number` -- the same screenshot confirms its exact
 *     structure: a FIXED, non-editable "966" box (no dropdown chevron,
 *     unlike the Communication Preference phone field's own "+998 v"
 *     country-code selector) plus a separate digits input. This is now a
 *     DELIBERATE, EVIDENCE-BACKED SKIP, not a structural unknown: the
 *     field carries no asterisk (optional), and "966" is Saudi Arabia's
 *     own fixed country code -- not the applicant's (Uzbekistan's). There
 *     is no confirmed correct value for what this field should hold for
 *     a not-yet-arrived applicant, and filling only the digits portion
 *     while the fixed "966" prefix stays as-is would silently produce an
 *     ACTIVELY WRONG combined phone number -- worse than leaving an
 *     optional field blank. Nothing is typed into it.
 *
 * Package 5.39 -- the Hotel field's autocomplete SUGGESTION selection is
 * a GENERAL, BEST-EFFORT attempt (fillHotelNameAndSelectSuggestion,
 * above), not a guess: it types the hotel name via real keystroke events,
 * then looks for ANY visible element whose own text contains every word
 * of the expected hotel name (matching even the real, longer,
 * address-qualified suggestion text a recovered screenshot showed), and
 * clicks ONLY that. It can therefore never select a WRONG hotel.
 *
 * This project's own updated rule (closing a real risk the earlier
 * Package 5.40 behavior left open): if no such element ever appears
 * within the bounded wait, the hotel selection is UNCONFIRMED, and this
 * function now deliberately STOPS here -- it never clicks Page 4's `Next
 * >` button, never advances to Page 5, and reports
 * `advancedToNextPage: false`. Typing a hotel NAME is not the same as
 * confirming the real portal actually resolved it to one specific real
 * hotel; advancing past an unconfirmed hotel field risks submitting an
 * application against the wrong (or no) address, so the safe behavior is
 * to leave the real portal exactly on Page 4, untouched beyond the
 * already-filled fields, for a human to inspect and correct.
 *
 * Only when `hotelSuggestionSelected` is true does this function proceed
 * to click Page 4's own confirmed `Next >` button (clickNext, above) --
 * per Package 5.40, that click itself is NOT a best-effort guess (the
 * button is confirmed to exist on this page), so a failure to find/click
 * it in THAT branch is treated as a genuine failure and propagates
 * uncaught, the same established UNEXPECTED_ERROR path as every other
 * confirmed-element action in this file.
 */
export interface FillApplicantTripDetailsFieldsResult {
  /** Whether fillHotelNameAndSelectSuggestion actually found and clicked a matching suggestion (see its own doc comment) -- false means the real widget's suggestion never became a matchable, visible text element within the bounded wait, and the typed text was simply left as-is. Exposed so a caller/test can observe this without it being treated as an error either way. */
  hotelSuggestionSelected: boolean;
  /** Whether this function actually clicked Page 4's `Next >` button. Always exactly equal to hotelSuggestionSelected -- false means this function deliberately stopped on Page 4 without advancing, per this project's own rule that an unconfirmed hotel selection must never proceed to the next step. Exposed separately (rather than letting a caller infer it from hotelSuggestionSelected) so a caller never has to re-derive this safety-relevant fact from an unrelated field. */
  advancedToNextPage: boolean;
}

export async function fillApplicantTripDetailsFields(page: Page, input: VisitSaudiTripDetailsFieldsInput): Promise<FillApplicantTripDetailsFieldsResult> {
  await ensureAnchorVisible(page, 'Passport Type', 'fillApplicantTripDetailsFields');

  await selectDropdownOptionCaseInsensitive(page.getByLabel('Passport Type', { exact: false }), CONFIRMED_VISIT_SAUDI_FORM_VALUES.passportType);
  await page.getByLabel('Passport No.', { exact: false }).fill(input.draft.passportNumber);
  await page.getByLabel('Passport Issue Place', { exact: false }).fill(input.countryOfBirth);
  // CORRECTED (real-run evidence): the operator's own Inspect-element
  // capture independently confirms all four of these fields (real ids
  // PassportIssueDate/PassportExpiryDate/ExpectedDateOfEntry/
  // ExpectedDateOfLeave) share the SAME real calendar-widget markup
  // Date of Birth was directly proven to use -- see
  // selectDateFromCalendarWidget's own doc comment for the full
  // evidence, including why clicking by real `id` replaced an earlier,
  // real-run-proven-unreliable getByLabel attempt.
  await selectDateFromCalendarWidget(page, 'PassportIssueDate', input.draft.passportIssueDate);
  await selectDateFromCalendarWidget(page, 'PassportExpiryDate', input.draft.passportExpiryDate);
  await selectDateFromCalendarWidget(page, 'ExpectedDateOfEntry', input.expectedDateOfArrival);
  await selectDateFromCalendarWidget(page, 'ExpectedDateOfLeave', input.expectedDateOfDeparture);

  // This project's own updated rule: ONLY UMRAH is clicked -- see
  // CONFIRMED_VISIT_SAUDI_FORM_VALUES's own doc comment for why LEISURE
  // was removed. No post-click verification is attempted here: the real
  // widget's type (radio/checkbox/other) has never been observed, and
  // calling a checkbox/radio-only API (e.g. .isChecked()) against an
  // element that turns out to be a plain styled <button> -- the same
  // convention every other click in this file already relies on -- would
  // itself throw for an unrelated reason. This is an openly-flagged
  // limitation, not a silent gap: whether UMRAH was genuinely selected on
  // the real portal is left for a human to confirm, same as every other
  // unverified click this file already makes (clickApplyForGroup,
  // confirmGroupCreation, etc.).
  await page.getByText(CONFIRMED_VISIT_SAUDI_FORM_VALUES.purpose, { exact: true }).click();

  await page.getByText('COMMERCIAL ACCOMMODATION', { exact: true }).click();
  const hotelSuggestionSelected = await fillHotelNameAndSelectSuggestion(page, CONFIRMED_VISIT_SAUDI_FORM_VALUES.hotelName);

  const emailAnswer = CONFIRMED_VISIT_SAUDI_FORM_VALUES.alternateEmailAnswer.toUpperCase() as 'YES' | 'NO';
  const phoneAnswer = CONFIRMED_VISIT_SAUDI_FORM_VALUES.alternatePhoneAnswer.toUpperCase() as 'YES' | 'NO';
  await answerCommunicationPreference(page, emailAnswer, phoneAnswer);

  await page.getByLabel('Email', { exact: true }).fill(input.draft.email);

  // Primary Contact Number is deliberately, permanently left untouched --
  // see this function's own doc comment above for why (optional field,
  // fixed Saudi "966" prefix that does not match the applicant's own
  // country, no confirmed correct value). This also means no single,
  // shared phone number is ever typed here for every applicant -- there
  // is currently no per-applicant phone number anywhere in this
  // codebase's own data (not in the Sheet read path, not in Telegram
  // message data), so filling this field correctly per-applicant would
  // require a new, separately-approved data source; leaving it blank
  // (its own confirmed-safe default) is correct either way.

  // This project's own updated rule: an unconfirmed hotel selection must
  // never advance past this page -- see this function's own doc comment
  // above. Every other field is already filled either way; only the
  // Next click itself is gated.
  if (!hotelSuggestionSelected) {
    return { hotelSuggestionSelected: false, advancedToNextPage: false };
  }

  // Only once every field above is genuinely filled, AND the hotel
  // selection is confirmed -- per Package 5.40, see this function's own
  // doc comment for why this click is treated as a real, confirmed
  // action rather than a best-effort attempt.
  await clickNext(page);

  return { hotelSuggestionSelected: true, advancedToNextPage: true };
}

/**
 * Package 5.37 -- the Insurance page's single, confirmed consent
 * checkbox: `"BY CHECKING THIS BOX I AGREE TO THE INSURANCE COVERAGE
 * LISTED ABOVE..."` (matched on a stable PREFIX only -- the exact SAR
 * fee amount in parentheses was observed as two DIFFERENT values across
 * two recovered screenshots, "65.00 SAR" and "95.00 SAR", so matching on
 * it would be unreliable; the prefix before it is identical in both).
 * Never selects or even looks at any insurance COMPANY card -- per this
 * project's own approved rule, only this one consent checkbox is ever
 * clicked on this page.
 *
 * UPDATED RULE: the operator explicitly authorized automated insurance
 * consent -- twice, each time after being told in plain terms that this
 * checkbox is actually a per-applicant fee acceptance ("...with a fee of
 * (95.00 SAR)", confirmed from the real portal's own markup) and not a
 * generic "I agree" control. visitSaudiBrowserAutomationAdapter.ts's own
 * submitApplicant flow now calls this function for real on Page 5 -- see
 * that file's own doc comment for the exact authorized behavior. This
 * remains separate from, and must never be extended to cover, `PAY FOR
 * GROUP` or `AGREE & COMPLETE PAYMENT`, which stay permanently off-limits
 * to automation.
 */
/**
 * Page 6's own confirmed arrival anchor -- see confirmTermsAndConditions's
 * own doc comment for why this checkbox's own text doubles as the anchor.
 */
export const TERMS_AND_CONDITIONS_ANCHOR = 'I have read and agree all the above terms and conditions';

export async function confirmInsuranceConsent(page: Page): Promise<void> {
  await ensureAnchorVisible(page, 'INSURANCE COVERAGE', 'confirmInsuranceConsent');
  await page.getByText('BY CHECKING THIS BOX I AGREE TO THE INSURANCE COVERAGE LISTED ABOVE', { exact: false }).click();
}

/**
 * Page 6 ("Terms and Conditions")'s own confirmed consent checkbox:
 * real markup is `<label for="chkSelectDeselectAll" ...>I have read and
 * agree all the above terms and conditions.</label>` (the real portal's
 * own `id`, confirmed via the operator's own Inspect-element capture --
 * not an invented selector). Matched on its own text, same convention as
 * confirmInsuranceConsent, so this does not depend on that `id` staying
 * stable. This is also used as Page 6's own arrival anchor
 * (TERMS_AND_CONDITIONS_ANCHOR below) -- no separate heading text has
 * ever been observed for this page, but this checkbox's own text is
 * itself unique and confirmed, so it serves both roles honestly.
 *
 * OPEN, EXPLICITLY FLAGGED GAP: it is not yet confirmed whether Page 6
 * has any OTHER required checkbox beside this one (the real id,
 * "chkSelectDeselectAll", suggests it might only be a "select/deselect
 * all" control for further individual items never yet observed). This
 * function clicks ONLY this one confirmed checkbox, exactly like
 * confirmInsuranceConsent clicks only its own one confirmed checkbox --
 * it never guesses at unconfirmed additional controls. If unconfirmed
 * additional requirements exist on the real portal, the honest
 * consequence is that the subsequent Next click may not actually advance
 * -- which visitSaudiBrowserAutomationAdapter.ts's own safe page-check
 * for Page 7 (never yet confirmed either) will correctly surface as
 * AMBIGUOUS, never silently guessed as success.
 */
export async function confirmTermsAndConditions(page: Page): Promise<void> {
  await ensureAnchorVisible(page, TERMS_AND_CONDITIONS_ANCHOR, 'confirmTermsAndConditions');
  await page.getByText(TERMS_AND_CONDITIONS_ANCHOR, { exact: false }).click();
}

/**
 * No evidence exists for what a successful save looks like (a toast? a
 * URL change? an updated applicant counter?), nor for an error state, nor
 * for the group-overview page listing the 10 Draft applications. Without
 * this, "confirm each save before advancing" and "stop at the group
 * overview with ten Drafts" cannot be implemented without guessing.
 *
 * Package 5.31: this project's own approved business rule made this
 * function UNUSED by visitSaudiBrowserAutomationAdapter.ts's default
 * submitApplicant flow -- a successful (non-throwing) SAVE /
 * SAVE AND MOVE TO THE NEXT APPLICANT click is now treated as the
 * required action on its own, deliberately without this kind of extra UI
 * confirmation. This function is kept, still un-implemented, only as a
 * placeholder for a possible future stricter mode, should real
 * confirmation evidence ever surface -- it is not currently dead code to
 * delete, nor is it wired into anything.
 */
export async function confirmSaveOutcome(): Promise<'SAVED' | 'ERROR' | 'AMBIGUOUS'> {
  throw new Error(
    'confirmSaveOutcome: NOT IMPLEMENTED -- no save-confirmation signal (success/error/ambiguous) has been observed yet.',
  );
}
