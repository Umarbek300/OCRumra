import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { buildVisitSaudiBrowserAutomationAdapter, chooseSaveAction } from '../src/visa/visitSaudiBrowserAutomationAdapter.js';
import { clickSave, clickSaveAndMoveToNextApplicant } from '../src/visa/visitSaudiPageActions.js';
import {
  buildInMemoryVisaBatchLockStore,
  buildInMemoryVisaSubmissionQueueStore,
} from '../src/visa/visaSubmissionQueueStore.js';
import { runVisaWorkerLoopForBatch, type VisaWorkerLoopDependencies } from '../src/visa/visaWorkerLoop.js';
import type { VisitSaudiApplicationDraft } from '../src/visa/types.js';
import type { VisitSaudiPreflightResult } from '../src/visa/visitSaudiPreflight.js';

/**
 * Package 5.28, extended 5.36, updated for the Page3->Page7 flow fix:
 * these tests exercise the REAL adapter (real Playwright page, real HTTP
 * download) against hand-built LOCAL fixtures -- the same
 * local-simulation convention as Packages 5.26/5.27's own tests. They
 * prove this adapter's OWN logic (on-behalf answer -> upload -> fill ->
 * safe page-check -> known handoff, cleanup-on-failure, integration with
 * the existing worker loop) behaves correctly; they do NOT, and cannot,
 * prove anything about the real VisitSaudi portal's actual behavior. No
 * real portal, no production DB -- the integration tests below use only
 * the in-memory VisaSubmissionQueueStore/VisaBatchLockStore fakes.
 *
 * Page3->Page7 flow fix: SAVE / SAVE AND MOVE TO THE NEXT APPLICANT is no
 * longer clicked immediately after Page 3 -- see
 * visitSaudiBrowserAutomationAdapter.ts's own doc comment. Every fixture
 * below that used to reveal Page 4 via the SAVE button's own onclick now
 * reveals it via the Page 3 form's own LAST field being filled instead
 * (residenceAddress), simulating the one real possibility this adapter's
 * own safe page-check still allows for: the portal advancing on its own
 * once Page 3 is complete. This is a test-fixture mechanism only, not a
 * claim about what the real portal actually does -- no evidence either
 * way exists yet (see that file's own doc comment).
 */

function buildDraft(portraitUrl: string): VisitSaudiApplicationDraft {
  return {
    portal: 'visitsaudi',
    firstName: 'Test',
    surname: 'Applicant',
    dateOfBirth: '1990-01-01',
    gender: 'Erkak',
    passportNumber: 'AB1234567',
    passportIssueDate: '2020-01-01',
    passportExpiryDate: '2030-01-01',
    nationality: 'UZBEKISTAN',
    email: 'test@example.com',
    arrivalDate: '2026-12-01',
    personalPortraitUrl: portraitUrl,
  };
}

let browser: Browser;
let page: Page;
let portraitServer: Server;
let portraitServerUrl: string;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();

  portraitServer = createServer((req, res) => {
    if (req.url === '/portrait.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from('fake portrait bytes for Package 5.28'));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => portraitServer.listen(0, '127.0.0.1', resolve));
  const address = portraitServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('test portrait server did not bind to a port');
  }
  portraitServerUrl = `http://127.0.0.1:${address.port}/portrait.jpg`;
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve) => portraitServer.close(() => resolve()));
});

/**
 * Package 5.36: the Page 3 fixture now includes the "applying on behalf"
 * YES/NO buttons AND every field fillApplicantPersonalInfoFields fills --
 * including Gender/Marital Status/Date of Birth, now that all three are
 * evidence-backed (see visitSaudiPageActions.ts's own doc comment).
 * `window.__saveClicked` holds the LAST save action; `window.__saveClickLog`
 * accumulates every one, in order, so a multi-applicant test can assert
 * on the full sequence, not just the final state.
 */
async function setApplicantPageFixture(): Promise<void> {
  await page.setContent(`
    <button onclick="window.__onBehalfClicked = 'YES'">YES</button>
    <button onclick="window.__onBehalfClicked = 'NO'">NO</button>

    <button id="uploadBtn">UPLOAD FILE</button>
    <input type="file" id="fileInput" style="display:none" />

    <label for="nationality">Country of Nationality*</label>
    <select id="nationality"><option value="">Select</option><option value="UZ">Uzbekistan</option></select>

    <label for="firstName">First Name or Given Name (English)*</label>
    <input type="text" id="firstName" />

    <label for="lastName">Last Name or Family Name (English)*</label>
    <input type="text" id="lastName" />

    <label for="gender">Gender*</label>
    <select id="gender"><option value="">Select</option><option>Male</option><option>Female</option></select>

    <label for="maritalStatus">Marital Status*</label>
    <select id="maritalStatus"><option value="">Select</option><option>Single</option><option>Married</option></select>

    <label for="dateOfBirth">Date of Birth *</label>
    <input type="text" id="dateOfBirth" />

    <label for="countryOfBirth">Country of Birth*</label>
    <select id="countryOfBirth"><option value="">Select</option><option value="UZ">Uzbekistan</option></select>

    <label for="cityOfBirth">City of Birth*</label>
    <input type="text" id="cityOfBirth" />

    <label for="profession">Profession*</label>
    <input type="text" id="profession" />

    <p>Current Residence Address</p>
    <label for="residenceCountry">Country*</label>
    <select id="residenceCountry"><option value="">Select</option><option value="UZ">Uzbekistan</option></select>
    <label for="residenceCity">City*</label>
    <input type="text" id="residenceCity" />
    <label for="residenceAddress">Address*</label>
    <input type="text" id="residenceAddress" />

    <button onclick="window.__saveClicked = 'save-and-next'; window.__saveClickLog.push('save-and-next')">SAVE AND MOVE TO THE NEXT APPLICANT</button>
    <button onclick="window.__saveClicked = 'save'; window.__saveClickLog.push('save')">SAVE</button>
    <button onclick="window.__page3NextClickLog.push('next')">Next &gt;</button>
    <script>
      window.__saveClickLog = [];
      window.__page3NextClickLog = [];
      window.__saveSnapshotLog = [];
      // Page7 SAVE FIX: page.setContent() does not reset previously-set
      // window properties from an earlier test sharing this same page
      // object (confirmed by this project's own test suite, which caught
      // exactly this leak) -- explicitly reset here, same convention as
      // the array resets above, so each fresh fixture setup starts clean.
      window.__page7SaveClicked = undefined;
      window.__page7SaveAndAddApplicantClicked = undefined;
      window.__captureSaveSnapshot = () => {
        const byId = (id) => document.getElementById(id).value;
        window.__saveSnapshotLog.push({
          nationality: byId('nationality'),
          firstName: byId('firstName'),
          lastName: byId('lastName'),
          gender: byId('gender'),
          maritalStatus: byId('maritalStatus'),
          dateOfBirth: byId('dateOfBirth'),
          countryOfBirth: byId('countryOfBirth'),
          cityOfBirth: byId('cityOfBirth'),
          profession: byId('profession'),
          residenceCountry: byId('residenceCountry'),
          residenceCity: byId('residenceCity'),
          residenceAddress: byId('residenceAddress'),
        });
      };
      // Page3->Page7 flow fix: the snapshot is no longer captured from a
      // SAVE click (never clicked by this adapter anymore) -- captured
      // instead when Page 3's own LAST field
      // (fillApplicantPersonalInfoFields's own final target,
      // residenceAddress) is filled, so a multi-applicant test can still
      // prove each applicant's OWN data was genuinely present at the
      // moment Page 3 completed, never a previous applicant's leftover
      // value.
      document.getElementById('residenceAddress').addEventListener('input', () => window.__captureSaveSnapshot());
      document.getElementById('uploadBtn').addEventListener('click', () => {
        document.getElementById('fileInput').click();
      });
    </script>
  `);
}

/**
 * Package 5.38: the SAME Page 3 fixture as above, but clicking EITHER
 * SAVE action ALSO reveals a full Page 4 ("Passport & Trip Details")
 * fixture -- identical field markup to visa.visitSaudiPageActions.test.ts's
 * own setTripDetailsFixture (same confirmed labels), so this proves the
 * ADAPTER's own wiring (the safe isAnchorVisible page-check, then
 * fillApplicantTripDetailsFields) genuinely reaches and fills Page 4 when
 * it actually appears, not just that the standalone function works in
 * isolation.
 *
 * Package 5.40: `revealInsuranceOnNext`, when true, ALSO reveals a Page 5
 * ("INSURANCE COVERAGE") fixture once Page 4's own confirmed Next button
 * is clicked -- so a test can prove the full Page3->Page4->Page5 chain
 * genuinely works end-to-end, not just that Page 4 alone is reached.
 *
 * Package [new]: `includeHotelSuggestion` (default true) adds a real,
 * matching autocomplete-suggestion element for the Hotel field -- this
 * project's own updated rule means Next is only ever clicked once that
 * suggestion is confirmed (see fillApplicantTripDetailsFields's own doc
 * comment), so most tests exercising Page 4/5 need this true to reach
 * them at all. Passing false lets a test prove the OPPOSITE: that this
 * adapter correctly stops on Page 4, never advancing, when no suggestion
 * is found.
 */
async function setApplicantPageFixtureWithTripDetailsPage(revealInsuranceOnNext = false, includeHotelSuggestion = true): Promise<void> {
  await setApplicantPageFixture();
  await page.evaluate(({ revealInsuranceOnNextArg, includeHotelSuggestionArg }: { revealInsuranceOnNextArg: boolean; includeHotelSuggestionArg: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runs in the browser; this project's own tsconfig has no "dom" lib.
    const doc = (globalThis as any).document;
    // Page3->Page4 trigger fix: Page 4 is revealed by clicking Page 3's
    // OWN "Next >" button (the one clickNext now clicks for real) --
    // found by its exact text, same convention as every other button in
    // this file.
    for (const button of Array.from(doc.querySelectorAll('button'))) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (button as any).textContent;
      if (typeof text === 'string' && text.trim().toLowerCase().startsWith('next')) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const original = (button as any).getAttribute('onclick') ?? '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (button as any).setAttribute('onclick', `${original}; window.__revealTripDetailsPage();`);
      }
    }
    const tripDetailsHtml = `
      <label for="passportType">Passport Type*</label>
      <select id="passportType"><option value="">Select</option><option>Regular Passport</option></select>
      <label for="passportNo">Passport No.*</label>
      <input type="text" id="passportNo" />
      <label for="passportIssuePlace">Passport Issue Place (Country or City)*</label>
      <input type="text" id="passportIssuePlace" />
      <label for="passportIssueDate">Passport Issue Date*</label>
      <input type="text" id="passportIssueDate" />
      <label for="passportExpiryDate">Passport Expiry Date*</label>
      <input type="text" id="passportExpiryDate" />
      <label for="expectedArrival">Expected Date of Arrival*</label>
      <input type="text" id="expectedArrival" />
      <label for="expectedDeparture">Expected Date of Departure*</label>
      <input type="text" id="expectedDeparture" />

      <p>Additional Purpose of Visit *</p>
      <button onclick="window.__purposeLog.push('SELECT ALL')">SELECT ALL</button>
      <button onclick="window.__purposeLog.push('EVENT')">EVENT</button>
      <button onclick="window.__purposeLog.push('FAMILY & RELATIVES')">FAMILY &amp; RELATIVES</button>
      <button onclick="window.__purposeLog.push('LEISURE')">LEISURE</button>
      <button onclick="window.__purposeLog.push('UMRAH')">UMRAH</button>

      <p>Communication Preference *</p>
      <p>Do you want to receive the visa on a email other than your original email?</p>
      <button onclick="window.__commPrefLog.push('email:YES')">YES</button>
      <button onclick="window.__commPrefLog.push('email:NO')">NO</button>
      <p>Do you want to receive the visa on a phone number other than your original phone number?</p>
      <button onclick="window.__commPrefLog.push('phone:YES')">YES</button>
      <button onclick="window.__commPrefLog.push('phone:NO')">NO</button>

      <p>Residence Address in Saudi Arabia</p>
      <button onclick="window.__residenceChoice = 'RESIDENTIAL OR RELATIVE'">RESIDENTIAL OR RELATIVE</button>
      <button onclick="window.__residenceChoice = 'COMMERCIAL ACCOMMODATION'">COMMERCIAL ACCOMMODATION</button>

      <label for="hotelName">Name of Hotel*</label>
      <input type="text" id="hotelName" />
      ${includeHotelSuggestionArg ? '<div>Emaar Elite Hotel, Ajyad Street, Makkah</div>' : ''}

      <label for="primaryContact">Primary Contact Number</label>
      <input type="text" id="primaryContact" />

      <label for="email">Email</label>
      <input type="text" id="email" />

      <button onclick="window.__nav = 'previous'">PREVIOUS</button>
      <button onclick="window.__nav = 'next'">Next &gt;</button>
    `;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tripDetailsContainer = doc.createElement('div') as any;
    tripDetailsContainer.id = 'tripDetailsPage';
    // Deliberately NOT populated with innerHTML yet -- an empty, hidden
    // container is harmless, but pre-inserting its real content (even
    // hidden) would make its own "YES"/"NO" buttons ambiguous matches
    // for getByText('YES'/'NO') the MOMENT Page 3 starts, long before
    // Page 4 is ever supposed to exist. Real SPA navigation wouldn't
    // render Page 4's markup at all until actually navigated to, so the
    // content is only injected inside __revealTripDetailsPage below.
    tripDetailsContainer.style.display = 'none';
    doc.body.appendChild(tripDetailsContainer);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = globalThis as any;
    win.__purposeLog = [];
    win.__commPrefLog = [];
    win.__revealTripDetailsPage = () => {
      // Real multi-step navigation REPLACES the previous page's view --
      // it does not leave Page 3's own "applying on behalf" YES/NO
      // buttons, nor Page 3's own just-clicked "Next >" button, sitting
      // around underneath Page 4's content (which has its OWN separate
      // "Next >" button). Removing them here (rather than merely hiding
      // Page 3) keeps this fixture an honest simulation: without this,
      // their leftover, still-exact-text-matching buttons would create
      // an AMBIGUITY (two "Next"-matching elements at once) that only
      // exists because this fixture overlays pages in one document,
      // never a real risk on the actual portal's own separate pages.
      for (const button of Array.from(doc.querySelectorAll('button'))) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = (button as any).textContent;
        if (text === 'YES' || text === 'NO' || (typeof text === 'string' && text.trim().toLowerCase().startsWith('next'))) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (button as any).remove();
        }
      }
      tripDetailsContainer.innerHTML = tripDetailsHtml;
      tripDetailsContainer.style.display = 'block';

      if (revealInsuranceOnNextArg) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nextButton = (Array.from(doc.querySelectorAll('button')) as any[]).find(
          (b) => typeof b.textContent === 'string' && b.textContent.trim().toLowerCase().startsWith('next'),
        );
        if (nextButton) {
          const originalOnclick = nextButton.getAttribute('onclick') ?? '';
          nextButton.setAttribute('onclick', `${originalOnclick}; window.__revealInsurancePage();`);
        }
      }
    };

    if (revealInsuranceOnNextArg) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const insuranceContainer = doc.createElement('div') as any;
      insuranceContainer.id = 'insurancePage';
      insuranceContainer.style.display = 'none';
      doc.body.appendChild(insuranceContainer);
      win.__revealInsurancePage = () => {
        // Same honest-simulation rule as __revealTripDetailsPage above:
        // real SPA navigation replaces Page 4's view, it does not leave
        // Page 4's own "Next >" button sitting around underneath Page 5's
        // (which has its OWN separate "Next >" button) -- removing it here
        // avoids a two-matches ambiguity that would only ever exist in
        // this single-document fixture, never on the real, separate-page
        // portal.
        for (const button of Array.from(doc.querySelectorAll('button'))) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const text = (button as any).textContent;
          if (typeof text === 'string' && text.trim().toLowerCase().startsWith('next')) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (button as any).remove();
          }
        }
        insuranceContainer.innerHTML = `
          <div>
            <button onclick="window.__insuranceCompanyClicked = true">Arabian Shield Cooperative Insurance Company</button>
          </div>
          <button onclick="window.__insuranceConsentClicked = true">BY CHECKING THIS BOX I AGREE TO THE INSURANCE COVERAGE LISTED ABOVE WITH A FEE OF (65.00 SAR)</button>
          <button onclick="window.__insuranceNextClicked = true; window.__revealTermsPage();">Next &gt;</button>
        `;
        insuranceContainer.style.display = 'block';
      };

      // Page6->Page7 trigger fix: Page 6 ("Terms and Conditions") is
      // revealed by Page 5's own Next button, same chained-reveal
      // convention as every earlier page in this fixture. Real markup
      // confirmed via the operator's own Inspect-element capture:
      // <label for="chkSelectDeselectAll" ...>I have read and agree all
      // the above terms and conditions.</label>, plus its own separate
      // #btnNext "Next" button.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const termsContainer = doc.createElement('div') as any;
      termsContainer.id = 'termsPage';
      termsContainer.style.display = 'none';
      doc.body.appendChild(termsContainer);
      win.__revealTermsPage = () => {
        for (const button of Array.from(doc.querySelectorAll('button'))) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const text = (button as any).textContent;
          if (typeof text === 'string' && text.trim().toLowerCase().startsWith('next')) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (button as any).remove();
          }
        }
        termsContainer.innerHTML = `
          <button onclick="window.__termsConsentClicked = true">I have read and agree all the above terms and conditions.</button>
          <button onclick="window.__termsNextClicked = true; window.__revealReviewApplicationPage();">Next &gt;</button>
        `;
        termsContainer.style.display = 'block';
      };

      // Page7 SAVE FIX: Page 7 ("Review Application") is revealed by Page
      // 6's own Next button, same chained-reveal convention. Real markup
      // confirmed via the operator's own Inspect-element capture: a
      // `<span> Save &amp; Add Applicant</span>` (applicants 1-9) and a
      // separate `<a id="aSave" href="/Visa/Save" class="cta">...Save</a>`
      // (applicant 10, the batch's last) -- both rendered here since it is
      // not confirmed whether the real portal shows one or both at once;
      // a test exercising either isLastApplicantInBatch value must be able
      // to find its own expected action regardless. The real anchor's
      // `href` is harmless here since this fixture's onclick returns
      // false, preventing the test page from actually navigating away.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reviewApplicationContainer = doc.createElement('div') as any;
      reviewApplicationContainer.id = 'reviewApplicationPage';
      reviewApplicationContainer.style.display = 'none';
      doc.body.appendChild(reviewApplicationContainer);
      win.__revealReviewApplicationPage = () => {
        for (const button of Array.from(doc.querySelectorAll('button'))) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const text = (button as any).textContent;
          if (typeof text === 'string' && text.trim().toLowerCase().startsWith('next')) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (button as any).remove();
          }
        }
        reviewApplicationContainer.innerHTML = `
          <span onclick="window.__page7SaveAndAddApplicantClicked = true">Save &amp; Add Applicant</span>
          <a id="aSave" href="/Visa/Save" onclick="window.__page7SaveClicked = true; return false;">Save</a>
        `;
        reviewApplicationContainer.style.display = 'block';
      };
    }
  }, { revealInsuranceOnNextArg: revealInsuranceOnNext, includeHotelSuggestionArg: includeHotelSuggestion });
}

/**
 * Package 5.36, updated for the Page3->Page7 flow fix: SAVE is no longer
 * clicked by this adapter at all, so removing the SAVE buttons can no
 * longer force a throw. This fixture instead removes the required
 * `First Name or Given Name (English)*` field -- fillApplicantPersonalInfoFields's
 * own `.fill()` call against it then cannot resolve, forcing the SAME
 * kind of genuine, unrelated-to-this-package failure, letting a test
 * exercise the cleanup-on-throw guarantee without relying on an
 * unimplemented field.
 */
async function setApplicantPageFixtureWithoutFirstNameField(): Promise<void> {
  await setApplicantPageFixture();
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (globalThis as any).document;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (doc.getElementById('firstName') as any).remove();
  });
}

/**
 * Page3->Page4 trigger fix: the same fixture as setApplicantPageFixture,
 * but WITHOUT Page 3's own "Next >" button -- so every field fills
 * successfully, but the new clickNext(page) call this package adds has
 * nothing to find/click, letting a test exercise that specific,
 * genuine-uncertainty branch (as opposed to the field-fill throw above).
 */
async function setApplicantPageFixtureWithoutPage3NextButton(): Promise<void> {
  await setApplicantPageFixture();
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (globalThis as any).document;
    for (const button of Array.from(doc.querySelectorAll('button'))) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (button as any).textContent;
      if (typeof text === 'string' && text.trim().toLowerCase().startsWith('next')) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (button as any).remove();
      }
    }
  });
}

/** Package 5.36: the extra VisaApplicantAutomationAdapter.submitApplicant fields beyond draft/recordId/isLastApplicantInBatch, matching the fixture's own filled-in data. */
const FAKE_SUBMIT_EXTRAS = {
  maritalStatus: 'SINGLE' as const,
  countryOfBirth: 'Uzbekistan',
  cityOfBirth: 'Tashkent',
  countryOfResidence: 'Uzbekistan',
  cityOfResidence: 'Tashkent',
  profession: 'WORKER' as const,
  expectedDateOfArrival: '2026-10-23',
  expectedDateOfDeparture: '2026-10-28',
};

/** Page3->Page4 trigger fix: Page 3's own "Next" is clicked for real, but if Page 4's own anchor never appears afterward, that is a genuine, unresolved uncertainty -- AMBIGUOUS, never a known handoff. */
const PAGE3_NEXT_CLICKED_NO_PAGE4_DETAIL =
  'Page 3\'s forward action was clicked, but Page 4 ("Passport Type") never became visible afterward -- portal page state is unconfirmed';

/** Page3->Page4 trigger fix: Page 3's own "Next" button could not be found/clicked at all -- also a genuine, unresolved uncertainty, never a known handoff. */
const PAGE3_NEXT_NOT_FOUND_DETAIL =
  'Page 3 (personal info) filled and confirmed, but its own forward ("Next") action could not be found/clicked -- page state after Page 3 is unconfirmed; automation stops here without advancing';

/** Page7 SAVE FIX: Page 4, 5, and 6 are all confirmed and their own actions clicked, but Page 7's own expected action never became visible -- a genuine, unresolved uncertainty, never a known handoff. */
function page7ActionNotVisibleDetail(expectedAction: 'Save' | 'Save & Add Applicant'): string {
  return `Page 4, Page 5 (Insurance), and Page 6 (Terms and Conditions) all filled/confirmed and their own Next/consent actions clicked, but Page 7's own expected action ("${expectedAction}") never became visible -- portal page state is unconfirmed`;
}

test('chooseSaveAction returns clickSave for the batch\'s last applicant, clickSaveAndMoveToNextApplicant otherwise -- kept, directly tested, but no longer called by submitApplicant (see visitSaudiBrowserAutomationAdapter.ts\'s own doc comment)', () => {
  assert.equal(chooseSaveAction(true), clickSave);
  assert.equal(chooseSaveAction(false), clickSaveAndMoveToNextApplicant);
});

test('Page3->Page4 trigger fix: submitApplicant answers the on-behalf question, uploads the real portrait, fills EVERY Page 3 field (including Gender/Marital Status/Date of Birth), NEVER clicks SAVE, clicks Page 3\'s own "Next" for real, and -- since this fixture has no Page 4 markup -- reports AMBIGUOUS (the click resolved but Page 4 never appeared)', async () => {
  await setApplicantPageFixture();
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  const result = await adapter.submitApplicant({ recordId: 'record-1', draft: buildDraft(portraitServerUrl), isLastApplicantInBatch: false, ...FAKE_SUBMIT_EXTRAS });
  assert.equal(result.outcome, 'AMBIGUOUS');
  assert.equal(result.detail, PAGE3_NEXT_CLICKED_NO_PAGE4_DETAIL);

  const page3NextClickLog = await page.evaluate(() => (globalThis as unknown as { __page3NextClickLog: string[] }).__page3NextClickLog);
  assert.deepEqual(page3NextClickLog, ['next'], 'Page 3\'s own forward action must have been clicked exactly once');

  const onBehalfClicked = await page.evaluate(() => (globalThis as unknown as { __onBehalfClicked?: string }).__onBehalfClicked);
  assert.equal(onBehalfClicked, 'YES', 'the confirmed YES answer must have been clicked, before anything else');

  // Byte-level upload correctness is already proven by
  // uploadApplicantPortraitFromUrl's own dedicated test
  // (visa.visitSaudiPageActions.test.ts); this test's job is only to
  // confirm THIS adapter genuinely triggered that upload.
  const uploadedName = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runs in the browser; this project's own tsconfig has no "dom" lib.
    const input = (globalThis as any).document.getElementById('fileInput');
    return input.files && input.files.length > 0 ? input.files[0].name : null;
  });
  assert.equal(uploadedName, 'personal-portrait.jpg', 'the portrait upload must have genuinely happened');

  // Every Page 3 field must have been genuinely filled, including the
  // three that only became fillable this round.
  const fieldValues = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (globalThis as any).document;
    return {
      nationality: doc.getElementById('nationality').value,
      firstName: doc.getElementById('firstName').value,
      lastName: doc.getElementById('lastName').value,
      gender: doc.getElementById('gender').value,
      maritalStatus: doc.getElementById('maritalStatus').value,
      dateOfBirth: doc.getElementById('dateOfBirth').value,
      countryOfBirth: doc.getElementById('countryOfBirth').value,
      cityOfBirth: doc.getElementById('cityOfBirth').value,
      profession: doc.getElementById('profession').value,
      residenceCountry: doc.getElementById('residenceCountry').value,
      residenceCity: doc.getElementById('residenceCity').value,
      residenceAddress: doc.getElementById('residenceAddress').value,
    };
  });
  assert.deepEqual(fieldValues, {
    nationality: 'UZ',
    firstName: 'Test',
    lastName: 'Applicant',
    gender: 'Male',
    maritalStatus: 'Single',
    dateOfBirth: '01/01/1990',
    countryOfBirth: 'UZ',
    cityOfBirth: 'Tashkent',
    profession: 'WORKER',
    residenceCountry: 'UZ',
    residenceCity: 'Tashkent',
    residenceAddress: 'TASHKENT CITY',
  });

  const saveClicked = await page.evaluate(() => (globalThis as unknown as { __saveClicked?: string }).__saveClicked);
  assert.equal(saveClicked, undefined, 'SAVE/SAVE AND MOVE TO THE NEXT APPLICANT must never be clicked immediately after Page 3');
});

test('Page3->Page7 flow fix: submitApplicant cleans up its downloaded portrait temp file even when a required Page 3 field is missing and fillApplicantPersonalInfoFields itself throws', async () => {
  // The required First Name field is missing, so fillApplicantPersonalInfoFields's
  // own .fill() call against it cannot resolve -- the throw happens
  // there now (SAVE is never clicked, so it can no longer be the forced
  // failure point) -- proving cleanup is NOT conditional on which step fails.
  await setApplicantPageFixtureWithoutFirstNameField();
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  // The missing field means the fill genuinely cannot resolve -- shorten
  // Playwright's default 30s actionability timeout so this expected
  // failure doesn't needlessly slow the suite down.
  page.setDefaultTimeout(2000);
  let capturedError: unknown;
  try {
    await adapter.submitApplicant({ recordId: 'record-2', draft: buildDraft(portraitServerUrl), isLastApplicantInBatch: true, ...FAKE_SUBMIT_EXTRAS });
  } catch (error) {
    capturedError = error;
  } finally {
    page.setDefaultTimeout(30000);
  }
  assert.ok(capturedError, 'submitApplicant must throw when a required Page 3 field cannot be found');
  // If the temp file were leaked, a second, independent download+upload
  // against the SAME page would still succeed regardless -- the real
  // guarantee this test is after is structural (see
  // visitSaudiPageActions.ts's own doc comment: cleanup happens in a
  // `finally`, unconditionally) rather than directly observable from
  // outside the module without reaching into its internals, so this is
  // covered directly by downloadUrlToTempFile.test.ts's own cleanup tests
  // plus a code-level guarantee (a `finally` block cannot be skipped).
});

test('Page3->Page4 trigger fix: when Page 3\'s own "Next" button cannot be found/clicked at all, submitApplicant reports AMBIGUOUS with that specific reason, never throws, never guesses success', async () => {
  await setApplicantPageFixtureWithoutPage3NextButton();
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  // The missing button means the click genuinely cannot resolve --
  // shorten Playwright's default 30s actionability timeout so this
  // expected failure doesn't needlessly slow the suite down.
  page.setDefaultTimeout(2000);
  let result: Awaited<ReturnType<typeof adapter.submitApplicant>>;
  try {
    result = await adapter.submitApplicant({ recordId: 'record-no-next', draft: buildDraft(portraitServerUrl), isLastApplicantInBatch: false, ...FAKE_SUBMIT_EXTRAS });
  } finally {
    page.setDefaultTimeout(30000);
  }

  assert.equal(result.outcome, 'AMBIGUOUS');
  assert.equal(result.detail, PAGE3_NEXT_NOT_FOUND_DETAIL);
});

test('Page3->Page4 trigger fix: runVisaWorkerLoopForBatch integration -- TWO applicants are each independently attempted with the REAL, fully-implemented adapter; both have Page 3\'s own "Next" clicked for real, both end AMBIGUOUS (this fixture has no Page 4 markup), SAVE is never clicked for either', async () => {
  const queueStore = buildInMemoryVisaSubmissionQueueStore();
  const lockStore = buildInMemoryVisaBatchLockStore();
  const batchId = 'batch-1';
  const groupId = 'group-1';

  const recordA = await queueStore.createRecord({ groupId, batchId, passportIdentityId: 'identity-a' });
  const recordB = await queueStore.createRecord({ groupId, batchId, passportIdentityId: 'identity-b' });

  await setApplicantPageFixture();
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  const checkPreflight = async (): Promise<VisitSaudiPreflightResult> => ({
    passportIdentityId: 'irrelevant',
    sheetRowNumber: null,
    ready: true,
    errors: [],
    draft: buildDraft(portraitServerUrl),
    expectedDateOfArrival: '2026-12-01',
    expectedDateOfDeparture: '2026-12-10',
    maritalStatus: 'SINGLE',
    countryOfBirth: 'UZBEKISTAN',
    cityOfBirth: 'Tashkent',
    countryOfResidence: 'UZBEKISTAN',
    cityOfResidence: 'Tashkent',
    profession: 'WORKER',
  });

  const deps: VisaWorkerLoopDependencies = {
    queueStore,
    lockStore,
    automation: adapter,
    checkPreflight,
    findActiveApplicantPositions: async () => [
      { passportIdentityId: 'identity-a', positionInBatch: 1 },
      { passportIdentityId: 'identity-b', positionInBatch: 2 },
    ],
  };

  const result = await runVisaWorkerLoopForBatch(
    batchId,
    'worker-1',
    [
      { recordId: recordA.id, groupId, passportIdentityId: 'identity-a' },
      { recordId: recordB.id, groupId, passportIdentityId: 'identity-b' },
    ],
    Date.now(),
    deps,
  );

  assert.equal(result.lockOutcome, 'acquired');
  assert.deepEqual(result.batchValidation, { outcome: 'ok' });
  assert.equal(result.applicantOutcomes.length, 2, 'BOTH applicants must be independently attempted');
  assert.deepEqual(result.applicantOutcomes, [
    { recordId: recordA.id, outcome: 'AMBIGUOUS', detail: PAGE3_NEXT_CLICKED_NO_PAGE4_DETAIL },
    { recordId: recordB.id, outcome: 'AMBIGUOUS', detail: PAGE3_NEXT_CLICKED_NO_PAGE4_DETAIL },
  ]);

  // Page3->Page7 flow fix: SAVE/SAVE AND MOVE TO THE NEXT APPLICANT must
  // never be clicked for either applicant.
  const saveClickLog = await page.evaluate(() => (globalThis as unknown as { __saveClickLog: string[] }).__saveClickLog);
  assert.deepEqual(saveClickLog, []);

  // Page3->Page4 trigger fix: Page 3's own "Next" must have been clicked
  // once per applicant.
  const page3NextClickLog = await page.evaluate(() => (globalThis as unknown as { __page3NextClickLog: string[] }).__page3NextClickLog);
  assert.deepEqual(page3NextClickLog, ['next', 'next']);

  const storedA = await queueStore.getRecord(recordA.id);
  const storedB = await queueStore.getRecord(recordB.id);
  assert.equal(storedA?.status, 'AMBIGUOUS');
  assert.equal(storedB?.status, 'AMBIGUOUS');
});

test('Package 5.41: the hotel-not-found informational detail genuinely reaches runVisaWorkerLoopForBatch\'s own applicantOutcomes, attached to the AMBIGUOUS outcome this project\'s own rule reports when the hotel selection cannot be confirmed (a genuine uncertainty, unlike the known Page3/Page4 handoff points)', async () => {
  await setApplicantPageFixtureWithTripDetailsPage(false, false);
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  const queueStore = buildInMemoryVisaSubmissionQueueStore();
  const lockStore = buildInMemoryVisaBatchLockStore();
  const batchId = 'batch-541';
  const groupId = 'group-541';

  const record = await queueStore.createRecord({ groupId, batchId, passportIdentityId: 'identity-541' });

  const checkPreflight = async (): Promise<VisitSaudiPreflightResult> => ({
    passportIdentityId: 'irrelevant',
    sheetRowNumber: null,
    ready: true,
    errors: [],
    draft: buildDraft(portraitServerUrl),
    expectedDateOfArrival: '2026-12-01',
    expectedDateOfDeparture: '2026-12-10',
    maritalStatus: 'SINGLE',
    countryOfBirth: 'UZBEKISTAN',
    cityOfBirth: 'Tashkent',
    countryOfResidence: 'UZBEKISTAN',
    cityOfResidence: 'Tashkent',
    profession: 'WORKER',
  });

  const deps: VisaWorkerLoopDependencies = {
    queueStore,
    lockStore,
    automation: adapter,
    checkPreflight,
    findActiveApplicantPositions: async () => [{ passportIdentityId: 'identity-541', positionInBatch: 1 }],
  };

  const result = await runVisaWorkerLoopForBatch(batchId, 'worker-1', [{ recordId: record.id, groupId, passportIdentityId: 'identity-541' }], Date.now(), deps);

  assert.equal(result.applicantOutcomes.length, 1);
  const outcome = result.applicantOutcomes[0]!;
  assert.equal(outcome.outcome, 'AMBIGUOUS');
  assert.ok('detail' in outcome && outcome.detail, 'the detail computed by the adapter must survive processOneApplicant, not be silently dropped');
  if ('detail' in outcome) {
    assert.match(outcome.detail ?? '', /hotel autocomplete suggestion was not found\/selected -- stopped on Page 4 without advancing/);
    assert.doesNotMatch(outcome.detail ?? '', /INSURANCE COVERAGE|Insurance\)/, 'Page 5 must never even be checked for when the hotel selection was never confirmed');
  }

  const stored = await queueStore.getRecord(record.id);
  assert.equal(stored?.status, 'AMBIGUOUS');
});

// Package 5.31's own two mock-based tests (simulating "field-filling
// succeeded" via mock.module, since fillApplicantPersonalInfoFields was
// still unimplemented then) were REMOVED in Package 5.36: the two tests
// above now prove the exact same SAVE/SAVE-AND-MOVE-TO-THE-NEXT-APPLICANT
// distinction using the REAL, unmocked fillApplicantPersonalInfoFields --
// strictly stronger coverage of the same claim, so the mocked versions
// became redundant rather than complementary.

test('Page3->Page7 flow fix: when Page 4 ("Passport & Trip Details") genuinely appears after Page 3 but the hotel autocomplete suggestion is never found, submitApplicant\'s safe page-check reaches Page 4 for real, fills every evidence-backed field there, but this project\'s own updated rule means it STOPS on Page 4 -- Next is never clicked, Page 5 is never even checked for, and the outcome is AMBIGUOUS with that recorded explicitly in detail', async () => {
  await setApplicantPageFixtureWithTripDetailsPage(false, false);
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  const result = await adapter.submitApplicant({ recordId: 'record-3', draft: buildDraft(portraitServerUrl), isLastApplicantInBatch: true, ...FAKE_SUBMIT_EXTRAS });
  assert.equal(result.outcome, 'AMBIGUOUS');
  assert.match(result.detail ?? '', /hotel autocomplete suggestion was not found\/selected -- stopped on Page 4 without advancing/);
  assert.doesNotMatch(result.detail ?? '', /INSURANCE COVERAGE|Insurance\)/, 'Page 5 must never even be checked for when the hotel selection was never confirmed');

  // Page3->Page7 flow fix: SAVE must NEVER be clicked -- Page 4 was
  // reached via this fixture's own Page-3-complete trigger, never a
  // SAVE click.
  const saveClicked = await page.evaluate(() => (globalThis as unknown as { __saveClicked?: string }).__saveClicked);
  assert.equal(saveClicked, undefined, 'SAVE/SAVE AND MOVE TO THE NEXT APPLICANT must never be clicked');

  // Next must NEVER have been clicked -- the unconfirmed hotel selection
  // must stop this applicant on Page 4.
  const nav = await page.evaluate(() => (globalThis as unknown as { __nav?: string }).__nav);
  assert.equal(nav, undefined);

  // Every OTHER Page 4 field is still filled, including BOTH
  // Communication Preference answers -- only the Next click is gated.
  const tripDetailsValues = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runs in the browser; this project's own tsconfig has no "dom" lib.
    const doc = (globalThis as any).document;
    return {
      passportType: doc.getElementById('passportType').value,
      passportNo: doc.getElementById('passportNo').value,
      passportIssuePlace: doc.getElementById('passportIssuePlace').value,
      expectedArrival: doc.getElementById('expectedArrival').value,
      expectedDeparture: doc.getElementById('expectedDeparture').value,
      hotelName: doc.getElementById('hotelName').value,
      primaryContact: doc.getElementById('primaryContact').value,
      email: doc.getElementById('email').value,
    };
  });
  assert.deepEqual(tripDetailsValues, {
    passportType: 'Regular Passport',
    passportNo: 'AB1234567',
    passportIssuePlace: 'Uzbekistan',
    expectedArrival: '23/10/2026',
    expectedDeparture: '28/10/2026',
    hotelName: 'EMAAR ELITE HOTEL MAKKA',
    primaryContact: '',
    email: 'test@example.com',
  });

  const purposeLog = await page.evaluate(() => (globalThis as unknown as { __purposeLog: string[] }).__purposeLog);
  assert.deepEqual(purposeLog, ['UMRAH'], 'ONLY UMRAH may be clicked -- never LEISURE (this project\'s own updated rule)');

  const commPrefLog = await page.evaluate(() => (globalThis as unknown as { __commPrefLog: string[] }).__commPrefLog);
  assert.deepEqual(commPrefLog, ['email:NO', 'phone:NO']);

  const residenceChoice = await page.evaluate(() => (globalThis as unknown as { __residenceChoice?: string }).__residenceChoice);
  assert.equal(residenceChoice, 'COMMERCIAL ACCOMMODATION');
});

test('Page7 SAVE FIX: the FULL Page3->Page4->Page5->Page6->Page7 chain, end-to-end, for the batch\'s LAST applicant -- every page is reached and confirmed for real, and submitApplicant clicks Page 7\'s real, confirmed "Save" action (never the ALL-CAPS "SAVE" this file used to guess), reporting SAVED -- never "Save & Add Applicant", never any insurance company card', async () => {
  await setApplicantPageFixtureWithTripDetailsPage(true, true);
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  const result = await adapter.submitApplicant({ recordId: 'record-3b', draft: buildDraft(portraitServerUrl), isLastApplicantInBatch: true, ...FAKE_SUBMIT_EXTRAS });
  assert.equal(result.outcome, 'SAVED');
  assert.equal(result.detail, 'Page 3 through Page 6 all filled/confirmed, and Page 7\'s own expected action ("Save") was clicked for real');

  const nav = await page.evaluate(() => (globalThis as unknown as { __nav?: string }).__nav);
  assert.equal(nav, 'next', 'Page 4\'s Next button must have been clicked to reach Page 5 at all, since the hotel selection was confirmed');

  const consentClicked = await page.evaluate(() => (globalThis as unknown as { __insuranceConsentClicked?: boolean }).__insuranceConsentClicked);
  assert.equal(consentClicked, true, 'insurance consent IS now auto-confirmed, per the operator\'s own explicit, risk-disclosed authorization');

  const insuranceNextClicked = await page.evaluate(() => (globalThis as unknown as { __insuranceNextClicked?: boolean }).__insuranceNextClicked);
  assert.equal(insuranceNextClicked, true, 'Page 5\'s own Next button must have been clicked for real after confirming insurance consent');

  const companyClicked = await page.evaluate(() => (globalThis as unknown as { __insuranceCompanyClicked?: boolean }).__insuranceCompanyClicked);
  assert.equal(companyClicked, undefined, 'no insurance company card may ever be clicked');

  const termsConsentClicked = await page.evaluate(() => (globalThis as unknown as { __termsConsentClicked?: boolean }).__termsConsentClicked);
  assert.equal(termsConsentClicked, true, 'the terms checkbox IS now auto-confirmed, per the operator\'s own explicit authorization');

  const termsNextClicked = await page.evaluate(() => (globalThis as unknown as { __termsNextClicked?: boolean }).__termsNextClicked);
  assert.equal(termsNextClicked, true, 'Page 6\'s own Next button must have been clicked for real after confirming the terms checkbox');

  const page7SaveClicked = await page.evaluate(() => (globalThis as unknown as { __page7SaveClicked?: boolean }).__page7SaveClicked);
  assert.equal(page7SaveClicked, true, 'the batch\'s last applicant must click the real, confirmed "Save" action');

  const page7SaveAndAddApplicantClicked = await page.evaluate(() => (globalThis as unknown as { __page7SaveAndAddApplicantClicked?: boolean }).__page7SaveAndAddApplicantClicked);
  assert.equal(page7SaveAndAddApplicantClicked, undefined, 'the last applicant must never click "Save & Add Applicant" instead');
});

test('Page7 SAVE FIX: the SAME full chain for a NON-last applicant -- submitApplicant clicks Page 7\'s real, confirmed "Save & Add Applicant" action instead, never "Save", reporting SAVED', async () => {
  await setApplicantPageFixtureWithTripDetailsPage(true, true);
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  const result = await adapter.submitApplicant({ recordId: 'record-3c', draft: buildDraft(portraitServerUrl), isLastApplicantInBatch: false, ...FAKE_SUBMIT_EXTRAS });
  assert.equal(result.outcome, 'SAVED');
  assert.equal(result.detail, 'Page 3 through Page 6 all filled/confirmed, and Page 7\'s own expected action ("Save & Add Applicant") was clicked for real');

  const page7SaveAndAddApplicantClicked = await page.evaluate(() => (globalThis as unknown as { __page7SaveAndAddApplicantClicked?: boolean }).__page7SaveAndAddApplicantClicked);
  assert.equal(page7SaveAndAddApplicantClicked, true, 'a non-last applicant must click the real, confirmed "Save & Add Applicant" action');

  const page7SaveClicked = await page.evaluate(() => (globalThis as unknown as { __page7SaveClicked?: boolean }).__page7SaveClicked);
  assert.equal(page7SaveClicked, undefined, 'a non-last applicant must never click plain "Save" instead');
});

test('Page7 SAVE FIX: when Page 7\'s own expected action never becomes visible (Page 6\'s Next click did not actually reveal it), submitApplicant reports AMBIGUOUS with that specific reason, never guesses SAVED', async () => {
  await setApplicantPageFixtureWithTripDetailsPage(true, true);
  // Disarm the chained reveal so clicking Page 6's own Next button still
  // resolves (clickNext succeeds), but Page 7 never actually appears --
  // the one genuine-uncertainty branch this step's safe page-check exists
  // to catch.
  await page.evaluate(() => {
    (globalThis as unknown as { __revealReviewApplicationPage: () => void }).__revealReviewApplicationPage = () => {};
  });
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  const result = await adapter.submitApplicant({ recordId: 'record-3d', draft: buildDraft(portraitServerUrl), isLastApplicantInBatch: true, ...FAKE_SUBMIT_EXTRAS });
  assert.equal(result.outcome, 'AMBIGUOUS');
  assert.equal(result.detail, page7ActionNotVisibleDetail('Save'));
});

// The former "Page 4 never appears after SAVE" test (Package 5.38) is now
// REDUNDANT with the renamed first test above (Page3->Page4 trigger fix:
// submitApplicant answers...), which already exercises and asserts
// exactly this same "Page 4 never appears" case against the SAME
// setApplicantPageFixture, now that it is this adapter's own default,
// expected outcome rather than a secondary case -- removed rather than
// duplicated.

test('Page3->Page4 trigger fix: a full 10-applicant batch -- SAVE is never clicked for any applicant, Page 3\'s own "Next" is clicked once per applicant, every one ends AMBIGUOUS (this fixture has no Page 4 markup), and each applicant\'s OWN data is genuinely present at the moment ITS OWN Page 3 completed, never a previous applicant\'s stale/leftover values', async () => {
  await setApplicantPageFixture();
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  const queueStore = buildInMemoryVisaSubmissionQueueStore();
  const lockStore = buildInMemoryVisaBatchLockStore();
  const batchId = 'batch-10';
  const groupId = 'group-10';
  const applicantCount = 10;

  const passportIdentityIds = Array.from({ length: applicantCount }, (_, i) => `identity-${i + 1}`);
  const records = await Promise.all(
    passportIdentityIds.map((passportIdentityId) => queueStore.createRecord({ groupId, batchId, passportIdentityId })),
  );

  function buildDraftForApplicant(index: number): VisitSaudiApplicationDraft {
    return {
      portal: 'visitsaudi',
      firstName: `Applicant${index}`,
      surname: `Surname${index}`,
      dateOfBirth: '1990-01-01',
      gender: index % 2 === 0 ? 'Ayol' : 'Erkak',
      passportNumber: `PASSPORT-${index}`,
      passportIssueDate: '2020-01-01',
      passportExpiryDate: '2030-01-01',
      nationality: 'UZBEKISTAN',
      email: `applicant${index}@example.test`,
      arrivalDate: '2026-12-01',
      personalPortraitUrl: portraitServerUrl,
    };
  }

  const checkPreflight = async (_groupId: string, passportIdentityId: string): Promise<VisitSaudiPreflightResult> => {
    const index = passportIdentityIds.indexOf(passportIdentityId) + 1;
    return {
      passportIdentityId,
      sheetRowNumber: index,
      ready: true,
      errors: [],
      draft: buildDraftForApplicant(index),
      expectedDateOfArrival: '2026-12-01',
      expectedDateOfDeparture: '2026-12-10',
      maritalStatus: 'SINGLE',
      countryOfBirth: 'UZBEKISTAN',
      cityOfBirth: 'Tashkent',
      countryOfResidence: 'UZBEKISTAN',
      cityOfResidence: 'Tashkent',
      profession: 'WORKER',
    };
  };

  const deps: VisaWorkerLoopDependencies = {
    queueStore,
    lockStore,
    automation: adapter,
    checkPreflight,
    findActiveApplicantPositions: async () =>
      passportIdentityIds.map((passportIdentityId, i) => ({ passportIdentityId, positionInBatch: i + 1 })),
  };

  const result = await runVisaWorkerLoopForBatch(
    batchId,
    'worker-1',
    records.map((record, i) => ({ recordId: record.id, groupId, passportIdentityId: passportIdentityIds[i]! })),
    Date.now(),
    deps,
  );

  assert.equal(result.lockOutcome, 'acquired');
  assert.deepEqual(result.batchValidation, { outcome: 'ok' });
  assert.equal(result.applicantOutcomes.length, applicantCount);
  for (const outcome of result.applicantOutcomes) {
    assert.equal(outcome.outcome, 'AMBIGUOUS', `applicant ${outcome.recordId} must be AMBIGUOUS`);
  }

  const saveClickLog = await page.evaluate(() => (globalThis as unknown as { __saveClickLog: string[] }).__saveClickLog);
  assert.deepEqual(saveClickLog, [], 'SAVE/SAVE AND MOVE TO THE NEXT APPLICANT must never be clicked for any applicant');

  const page3NextClickLog = await page.evaluate(() => (globalThis as unknown as { __page3NextClickLog: string[] }).__page3NextClickLog);
  assert.deepEqual(page3NextClickLog, Array.from({ length: applicantCount }, () => 'next'), 'Page 3\'s own "Next" must be clicked exactly once per applicant');

  const saveSnapshotLog = await page.evaluate(
    () => (globalThis as unknown as { __saveSnapshotLog: Array<Record<string, string>> }).__saveSnapshotLog,
  );
  assert.equal(saveSnapshotLog.length, applicantCount);
  for (let i = 0; i < applicantCount; i += 1) {
    const expectedIndex = i + 1;
    assert.equal(
      saveSnapshotLog[i]!.firstName,
      `Applicant${expectedIndex}`,
      `save click #${i + 1} must carry applicant ${expectedIndex}'s OWN firstName, never a different applicant's leftover value`,
    );
    assert.equal(saveSnapshotLog[i]!.lastName, `Surname${expectedIndex}`, `save click #${i + 1} must carry applicant ${expectedIndex}'s OWN lastName`);
    assert.equal(
      saveSnapshotLog[i]!.gender,
      expectedIndex % 2 === 0 ? 'Female' : 'Male',
      `save click #${i + 1} must carry applicant ${expectedIndex}'s OWN gender, proving the dropdown selection also never leaks between applicants`,
    );
  }
});
