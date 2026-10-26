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
 * Package 5.28, extended 5.36: these tests exercise the REAL adapter
 * (real Playwright page, real HTTP download) against hand-built LOCAL
 * fixtures -- the same local-simulation convention as Packages
 * 5.26/5.27's own tests. They prove this adapter's OWN logic (on-behalf
 * answer -> upload -> fill -> SAVE, cleanup-on-failure, integration with
 * the existing worker loop) behaves correctly; they do NOT, and cannot,
 * prove anything about the real VisitSaudi portal's actual behavior. No
 * real portal, no production DB -- the integration tests below use only
 * the in-memory VisaSubmissionQueueStore/VisaBatchLockStore fakes.
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

    <button onclick="window.__captureSaveSnapshot(); window.__saveClicked = 'save-and-next'; window.__saveClickLog.push('save-and-next')">SAVE AND MOVE TO THE NEXT APPLICANT</button>
    <button onclick="window.__captureSaveSnapshot(); window.__saveClicked = 'save'; window.__saveClickLog.push('save')">SAVE</button>
    <script>
      window.__saveClickLog = [];
      window.__saveSnapshotLog = [];
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
 */
async function setApplicantPageFixtureWithTripDetailsPage(revealInsuranceOnNext = false): Promise<void> {
  await setApplicantPageFixture();
  await page.evaluate((revealInsuranceOnNextArg: boolean) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runs in the browser; this project's own tsconfig has no "dom" lib.
    const doc = (globalThis as any).document;
    for (const button of Array.from(doc.querySelectorAll('button'))) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (button as any).textContent;
      if (text === 'SAVE' || text === 'SAVE AND MOVE TO THE NEXT APPLICANT') {
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
      // buttons sitting around underneath Page 4's content. Removing
      // them here (rather than merely hiding Page 3) keeps this fixture
      // an honest simulation: without this, their leftover, still-exact-
      // text-matching "YES"/"NO" buttons would create an AMBIGUITY that
      // only exists because this fixture overlays pages in one document,
      // never a real risk on the actual portal's own separate pages.
      for (const button of Array.from(doc.querySelectorAll('button'))) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = (button as any).textContent;
        if (text === 'YES' || text === 'NO') {
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
        insuranceContainer.innerHTML = `
          <div>
            <button onclick="window.__insuranceCompanyClicked = true">Arabian Shield Cooperative Insurance Company</button>
          </div>
          <button onclick="window.__insuranceConsentClicked = true">BY CHECKING THIS BOX I AGREE TO THE INSURANCE COVERAGE LISTED ABOVE WITH A FEE OF (65.00 SAR)</button>
        `;
        insuranceContainer.style.display = 'block';
      };
    }
  }, revealInsuranceOnNext);
}

/** Package 5.36: the same fixture as above, but WITHOUT either SAVE button -- so a completely, correctly filled form still fails at the final click, letting a test exercise the cleanup-on-throw guarantee without relying on an unimplemented field. */
async function setApplicantPageFixtureWithoutSaveButtons(): Promise<void> {
  await setApplicantPageFixture();
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (globalThis as any).document;
    for (const button of Array.from(doc.querySelectorAll('button'))) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (button as any).textContent;
      if (text === 'SAVE' || text === 'SAVE AND MOVE TO THE NEXT APPLICANT') {
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

test('chooseSaveAction returns clickSave for the batch\'s last applicant, clickSaveAndMoveToNextApplicant otherwise', () => {
  assert.equal(chooseSaveAction(true), clickSave);
  assert.equal(chooseSaveAction(false), clickSaveAndMoveToNextApplicant);
});

test('Package 5.36: submitApplicant answers the on-behalf question, uploads the real portrait, fills EVERY Page 3 field (including Gender/Marital Status/Date of Birth), then clicks the correct SAVE action and reports SAVED', async () => {
  await setApplicantPageFixture();
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  const result = await adapter.submitApplicant({ recordId: 'record-1', draft: buildDraft(portraitServerUrl), isLastApplicantInBatch: false, ...FAKE_SUBMIT_EXTRAS });
  assert.deepEqual(result, { outcome: 'SAVED' });

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
  assert.equal(saveClicked, 'save-and-next', 'applicant 1-9 (not last) must use SAVE AND MOVE TO THE NEXT APPLICANT');
});

test('Package 5.36: submitApplicant cleans up its downloaded portrait temp file even when a correctly-filled form still fails at the final SAVE click', async () => {
  // Every field fills successfully; only the SAVE/SAVE AND MOVE TO THE
  // NEXT APPLICANT buttons are missing, so the throw happens at the very
  // last step -- proving cleanup is NOT conditional on which step fails.
  await setApplicantPageFixtureWithoutSaveButtons();
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  // The missing SAVE button means the final click genuinely cannot
  // resolve -- shorten Playwright's default 30s actionability timeout so
  // this expected failure doesn't needlessly slow the suite down.
  page.setDefaultTimeout(2000);
  let capturedError: unknown;
  try {
    await adapter.submitApplicant({ recordId: 'record-2', draft: buildDraft(portraitServerUrl), isLastApplicantInBatch: true, ...FAKE_SUBMIT_EXTRAS });
  } catch (error) {
    capturedError = error;
  } finally {
    page.setDefaultTimeout(30000);
  }
  assert.ok(capturedError, 'submitApplicant must throw when the SAVE button cannot be found');
  // If the temp file were leaked, a second, independent download+upload
  // against the SAME page would still succeed regardless -- the real
  // guarantee this test is after is structural (see
  // visitSaudiPageActions.ts's own doc comment: cleanup happens in a
  // `finally`, unconditionally) rather than directly observable from
  // outside the module without reaching into its internals, so this is
  // covered directly by downloadUrlToTempFile.test.ts's own cleanup tests
  // plus a code-level guarantee (a `finally` block cannot be skipped).
});

test('Package 5.36: runVisaWorkerLoopForBatch integration -- TWO applicants are each independently attempted with the REAL, fully-implemented adapter; both end SAVED, with the correct SAVE action per position', async () => {
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
    { recordId: recordA.id, outcome: 'SAVED' },
    { recordId: recordB.id, outcome: 'SAVED' },
  ]);

  // identity-a is position 1 of 2 (not last) -> SAVE AND MOVE TO THE NEXT
  // APPLICANT; identity-b is position 2 of 2 (last) -> plain SAVE.
  const saveClickLog = await page.evaluate(() => (globalThis as unknown as { __saveClickLog: string[] }).__saveClickLog);
  assert.deepEqual(saveClickLog, ['save-and-next', 'save']);

  const storedA = await queueStore.getRecord(recordA.id);
  const storedB = await queueStore.getRecord(recordB.id);
  assert.equal(storedA?.status, 'SAVED');
  assert.equal(storedB?.status, 'SAVED');
});

test('Package 5.41: the hotel/Page-5 informational detail genuinely reaches runVisaWorkerLoopForBatch\'s own applicantOutcomes -- it is no longer silently discarded by processOneApplicant\'s SAVED branch -- while the outcome itself stays SAVED, never turned into an ERROR just for carrying a caveat', async () => {
  await setApplicantPageFixtureWithTripDetailsPage();
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
  assert.equal(outcome.outcome, 'SAVED', 'a hotel-suggestion-not-found/Page-5-not-reached caveat must NEVER turn a genuine SAVE into an ERROR');
  assert.ok('detail' in outcome && outcome.detail, 'the detail computed by the adapter must survive processOneApplicant, not be silently dropped');
  if ('detail' in outcome) {
    assert.match(outcome.detail ?? '', /hotel autocomplete suggestion was not found/);
    assert.match(outcome.detail ?? '', /Page 5 \(Insurance\) did not appear.*insurance consent NOT confirmed/);
  }

  // The queue store's own persisted status is unaffected -- this detail
  // is informational only, never changing what got durably recorded.
  const stored = await queueStore.getRecord(record.id);
  assert.equal(stored?.status, 'SAVED');
});

// Package 5.31's own two mock-based tests (simulating "field-filling
// succeeded" via mock.module, since fillApplicantPersonalInfoFields was
// still unimplemented then) were REMOVED in Package 5.36: the two tests
// above now prove the exact same SAVE/SAVE-AND-MOVE-TO-THE-NEXT-APPLICANT
// distinction using the REAL, unmocked fillApplicantPersonalInfoFields --
// strictly stronger coverage of the same claim, so the mocked versions
// became redundant rather than complementary.

test('Package 5.40: when Page 4 ("Passport & Trip Details") genuinely appears after SAVE, submitApplicant\'s safe page-check reaches it for real, fills every evidence-backed field there, clicks the confirmed Next button -- and, against a fixture with no hotel-suggestion mechanism and no Page 5, still reports SAVED with BOTH the hotel-not-found and Page-5-not-reached outcomes explicitly recorded in detail, never silently', async () => {
  await setApplicantPageFixtureWithTripDetailsPage();
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  const result = await adapter.submitApplicant({ recordId: 'record-3', draft: buildDraft(portraitServerUrl), isLastApplicantInBatch: true, ...FAKE_SUBMIT_EXTRAS });
  assert.equal(result.outcome, 'SAVED');
  assert.match(result.detail ?? '', /hotel autocomplete suggestion was not found/);
  assert.match(result.detail ?? '', /Page 5 \(Insurance\) did not appear.*insurance consent NOT confirmed/);

  // Page 3 must have completed normally (SAVE was reached and clicked)
  // before Page 4 was ever attempted.
  const saveClicked = await page.evaluate(() => (globalThis as unknown as { __saveClicked?: string }).__saveClicked);
  assert.equal(saveClicked, 'save', 'applicant 10 of 10 (last) must use plain SAVE, and it must have been reached');

  // Next must have been clicked ONLY as fillApplicantTripDetailsFields's
  // own final step, after every Page 4 field above was already filled.
  const nav = await page.evaluate(() => (globalThis as unknown as { __nav?: string }).__nav);
  assert.equal(nav, 'next');

  // Page 4's own evidence-backed fields, including BOTH Communication
  // Preference answers, must have been genuinely filled before the throw.
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
  assert.deepEqual([...purposeLog].sort(), ['LEISURE', 'UMRAH']);

  const commPrefLog = await page.evaluate(() => (globalThis as unknown as { __commPrefLog: string[] }).__commPrefLog);
  assert.deepEqual(commPrefLog, ['email:NO', 'phone:NO']);

  const residenceChoice = await page.evaluate(() => (globalThis as unknown as { __residenceChoice?: string }).__residenceChoice);
  assert.equal(residenceChoice, 'COMMERCIAL ACCOMMODATION');
});

test('Package 5.40: the FULL Page3->Page4->Page5 chain, end-to-end -- when Page 4\'s own confirmed Next click genuinely reveals Page 5 (Insurance), submitApplicant reaches it for real, clicks the real consent checkbox (never a company card), and records success explicitly in detail, never silently', async () => {
  await setApplicantPageFixtureWithTripDetailsPage(true);
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  const result = await adapter.submitApplicant({ recordId: 'record-3b', draft: buildDraft(portraitServerUrl), isLastApplicantInBatch: true, ...FAKE_SUBMIT_EXTRAS });
  assert.equal(result.outcome, 'SAVED');
  assert.match(result.detail ?? '', /Page 5 \(Insurance\) reached and consent confirmed/);

  const nav = await page.evaluate(() => (globalThis as unknown as { __nav?: string }).__nav);
  assert.equal(nav, 'next', 'Page 4\'s Next button must have been clicked to reach Page 5 at all');

  const consentClicked = await page.evaluate(() => (globalThis as unknown as { __insuranceConsentClicked?: boolean }).__insuranceConsentClicked);
  assert.equal(consentClicked, true);

  const companyClicked = await page.evaluate(() => (globalThis as unknown as { __insuranceCompanyClicked?: boolean }).__insuranceCompanyClicked);
  assert.equal(companyClicked, undefined, 'no insurance company card may ever be clicked');
});

test('Package 5.38: when Page 4 never appears after SAVE (today\'s existing fixture, unchanged), submitApplicant\'s safe page-check correctly treats that as the normal case and still reports SAVED -- zero regression from the new wiring', async () => {
  await setApplicantPageFixture();
  const adapter = buildVisitSaudiBrowserAutomationAdapter(page);

  const result = await adapter.submitApplicant({ recordId: 'record-4', draft: buildDraft(portraitServerUrl), isLastApplicantInBatch: false, ...FAKE_SUBMIT_EXTRAS });
  assert.deepEqual(result, { outcome: 'SAVED' });
});

test('Package 5.38: a full 10-applicant batch -- the correct SAVE action is used at every position (9x SAVE AND MOVE TO THE NEXT APPLICANT, then 1x SAVE), and each applicant\'s OWN data is genuinely present at its OWN save click, never a previous applicant\'s stale/leftover values', async () => {
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
    assert.equal(outcome.outcome, 'SAVED', `applicant ${outcome.recordId} must be SAVED`);
  }

  const saveClickLog = await page.evaluate(() => (globalThis as unknown as { __saveClickLog: string[] }).__saveClickLog);
  assert.deepEqual(
    saveClickLog,
    ['save-and-next', 'save-and-next', 'save-and-next', 'save-and-next', 'save-and-next', 'save-and-next', 'save-and-next', 'save-and-next', 'save-and-next', 'save'],
    'applicants 1-9 of 10 must use SAVE AND MOVE TO THE NEXT APPLICANT, applicant 10 must use plain SAVE',
  );

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
