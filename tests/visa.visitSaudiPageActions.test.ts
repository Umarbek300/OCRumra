import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { cleanupDownloadedTempFile } from '../src/visa/downloadUrlToTempFile.js';
import {
  answerApplyingOnBehalfOfSomeoneElse,
  answerCommunicationPreference,
  clickApplyForGroup,
  clickNext,
  clickPrevious,
  clickSave,
  clickSaveAndMoveToNextApplicant,
  CONFIRMED_APPLYING_ON_BEHALF_OF_SOMEONE_ELSE_ANSWER,
  CONFIRMED_VISIT_SAUDI_FORM_VALUES,
  confirmGroupCreation,
  confirmInsuranceConsent,
  confirmSaveOutcome,
  createVisitSaudiGroup,
  enterGroupName,
  fillApplicantPersonalInfoFields,
  fillApplicantTripDetailsFields,
  fillHotelNameAndSelectSuggestion,
  isAnchorVisible,
  uploadApplicantPortrait,
  uploadApplicantPortraitFromUrl,
} from '../src/visa/visitSaudiPageActions.js';

/**
 * Package 5.26: these fixtures are a hand-built, minimal stand-in
 * reproducing ONLY the user's own verified, recovered VisitSaudi text
 * labels (see visitSaudiPageActions.ts's own doc comment for the exact
 * evidence each one traces to) -- never a claim about the real portal's
 * actual markup, structure, or styling beyond matching those exact labels.
 * These tests prove this file's own locator/action logic behaves
 * correctly against text it is designed to match; they do NOT, and
 * cannot, prove anything about the real VisitSaudi site itself. No real
 * portal, no database, no Redis -- this file needs none of them.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PORTRAIT_PATH = path.join(__dirname, 'fixtures', 'visitSaudiTestPortrait.jpg');

let browser: Browser;
let page: Page;
let portraitServer: Server;
let portraitServerUrl: string;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();

  // A tiny LOCAL HTTP server standing in for applicantPortraitRoute.ts's
  // own plain, unauthenticated GET (see downloadUrlToTempFile.ts's own
  // doc comment) -- never a real or third-party endpoint.
  portraitServer = createServer((req, res) => {
    if (req.url === '/visa-portraits/test-token') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from('fake portrait bytes for Package 5.27'));
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
  portraitServerUrl = `http://127.0.0.1:${address.port}/visa-portraits/test-token`;
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve) => portraitServer.close(() => resolve()));
});

test('clickApplyForGroup clicks the element bearing the exact confirmed text "APPLY FOR GROUP"', async () => {
  await page.setContent(`
    <button id="individual">APPLY FOR INDIVIDUAL</button>
    <button id="group" onclick="window.__clicked = 'group'">APPLY FOR GROUP</button>
  `);
  await clickApplyForGroup(page);
  assert.equal(await page.evaluate(() => (globalThis as unknown as { __clicked?: string }).__clicked), 'group');
});

test('enterGroupName fills the field labeled "Group Name*" even though the function matches without the trailing asterisk', async () => {
  await page.setContent(`
    <label for="groupName">Group Name*</label>
    <input id="groupName" type="text" />
  `);
  await enterGroupName(page, '26.10-1');
  const value = await page.locator('#groupName').inputValue();
  assert.equal(value, '26.10-1');
});

test('confirmGroupCreation clicks the element whose exact text is "+"', async () => {
  await page.setContent(`<button onclick="window.__plusClicked = true">+</button>`);
  await confirmGroupCreation(page);
  assert.equal(await page.evaluate(() => (globalThis as unknown as { __plusClicked?: boolean }).__plusClicked), true);
});

test('Package 5.27: createVisitSaudiGroup chains clickApplyForGroup -> enterGroupName -> confirmGroupCreation in order, using the given group name verbatim, then confirms creation by waiting for Page 3\'s own anchor', async () => {
  await page.setContent(`
    <div id="dashboard">
      <button onclick="window.__step = 'applyForGroup'; document.getElementById('dashboard').style.display='none'; document.getElementById('groupForm').style.display='block';">APPLY FOR GROUP</button>
    </div>
    <div id="groupForm" style="display:none">
      <label for="groupName">Group Name*</label>
      <input id="groupName" type="text" />
      <button onclick="window.__confirmedName = document.getElementById('groupName').value; window.__step = 'confirmed'; document.getElementById('groupForm').style.display='none'; document.getElementById('page3').style.display='block';">+</button>
    </div>
    <div id="page3" style="display:none">
      <button id="uploadBtn">UPLOAD FILE</button>
    </div>
  `);

  // The same already-tested, already-approved format from buildVisaBatchName.ts
  // (assignVisaBatch.ts's own batch-naming logic) -- never reformatted here.
  await createVisitSaudiGroup(page, '26.10-1');

  assert.equal(await page.evaluate(() => (globalThis as unknown as { __step?: string }).__step), 'confirmed');
  assert.equal(await page.evaluate(() => (globalThis as unknown as { __confirmedName?: string }).__confirmedName), '26.10-1');
});

test('Package [new]: createVisitSaudiGroup throws a clear, named error when group creation cannot be confirmed (Page 3\'s own anchor never appears after clicking "+")', async () => {
  await page.setContent(`
    <div id="dashboard">
      <button onclick="window.__step = 'applyForGroup'; document.getElementById('dashboard').style.display='none'; document.getElementById('groupForm').style.display='block';">APPLY FOR GROUP</button>
    </div>
    <div id="groupForm" style="display:none">
      <label for="groupName">Group Name*</label>
      <input id="groupName" type="text" />
      <button onclick="window.__step = 'confirmed';">+</button>
    </div>
  `);

  await assert.rejects(
    () => createVisitSaudiGroup(page, '26.10-1'),
    /createVisitSaudiGroup: group creation could not be confirmed/,
  );
});

test('clickPrevious and clickNext each click their own exact-text button, never the other', async () => {
  await page.setContent(`
    <button onclick="window.__nav = 'previous'">PREVIOUS</button>
    <button onclick="window.__nav = 'next'">NEXT &gt;</button>
  `);
  await clickPrevious(page);
  assert.equal(await page.evaluate(() => (globalThis as unknown as { __nav?: string }).__nav), 'previous');

  await clickNext(page);
  assert.equal(await page.evaluate(() => (globalThis as unknown as { __nav?: string }).__nav), 'next');
});

test('uploadApplicantPortrait triggers the "UPLOAD FILE" control and supplies the given local file via the native filechooser', async () => {
  await page.setContent(`
    <button id="uploadBtn">UPLOAD FILE</button>
    <input type="file" id="fileInput" style="display:none" />
    <script>
      document.getElementById('uploadBtn').addEventListener('click', () => {
        document.getElementById('fileInput').click();
      });
    </script>
  `);
  await uploadApplicantPortrait(page, TEST_PORTRAIT_PATH);
  const uploadedName = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runs in the browser; this project's own tsconfig has no "dom" lib.
    const documentRef = (globalThis as any).document;
    const input = documentRef.getElementById('fileInput');
    return input.files && input.files.length > 0 ? input.files[0].name : null;
  });
  assert.equal(uploadedName, 'visitSaudiTestPortrait.jpg');
});

test('Portrait-upload confirmation: uploadApplicantPortrait throws when the real <input> element shows a 0-byte file afterward, instead of silently treating setFiles() not throwing as success', async () => {
  const emptyFileDir = mkdtempSync(path.join(tmpdir(), 'visitsaudi-empty-portrait-'));
  const emptyFilePath = path.join(emptyFileDir, 'empty.jpg');
  writeFileSync(emptyFilePath, Buffer.alloc(0));

  await page.setContent(`
    <button id="uploadBtn">UPLOAD FILE</button>
    <input type="file" id="fileInput" style="display:none" />
    <script>
      document.getElementById('uploadBtn').addEventListener('click', () => {
        document.getElementById('fileInput').click();
      });
    </script>
  `);

  await assert.rejects(
    uploadApplicantPortrait(page, emptyFilePath),
    /does not show exactly one non-empty file afterward/,
    'a genuinely 0-byte file must never be treated as a successful upload',
  );
});

test('Package 5.27: uploadApplicantPortraitFromUrl downloads the given URL and uploads the SAME bytes via the native filechooser', async () => {
  await page.setContent(`
    <button id="uploadBtn">UPLOAD FILE</button>
    <input type="file" id="fileInput" style="display:none" />
    <script>
      document.getElementById('uploadBtn').addEventListener('click', () => {
        document.getElementById('fileInput').click();
      });
    </script>
  `);

  const downloadedPath = await uploadApplicantPortraitFromUrl(page, portraitServerUrl);

  const uploaded = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runs in the browser; this project's own tsconfig has no "dom" lib.
    const documentRef = (globalThis as any).document;
    const input = documentRef.getElementById('fileInput');
    return input.files && input.files.length > 0 ? { name: input.files[0].name, size: input.files[0].size } : null;
  });
  assert.ok(uploaded);
  assert.equal(uploaded!.name, 'personal-portrait.jpg');
  assert.equal(uploaded!.size, Buffer.from('fake portrait bytes for Package 5.27').length, 'the uploaded bytes must match what the local test server served, nothing invented or truncated');

  // Package 5.27's own real finding: the function deliberately does NOT
  // delete its own downloaded file (see its doc comment) -- confirm the
  // CALLER's own cleanup, done only AFTER reading the result above, is
  // what this test demonstrates as the correct usage pattern.
  await cleanupDownloadedTempFile(downloadedPath);
});

test('clickSaveAndMoveToNextApplicant and clickSave each click their OWN exact, real-portal-confirmed button text ("Save & Add Applicant" / "Save"), never confused by "Save" being a substring of the other', async () => {
  await page.setContent(`
    <span onclick="window.__action = 'save-and-next'"> Save &amp; Add Applicant</span>
    <a id="aSave" href="/Visa/Save" onclick="window.__action = 'save'; return false;">Save</a>
  `);
  await clickSaveAndMoveToNextApplicant(page);
  assert.equal(await page.evaluate(() => (globalThis as unknown as { __action?: string }).__action), 'save-and-next');

  await clickSave(page);
  assert.equal(await page.evaluate(() => (globalThis as unknown as { __action?: string }).__action), 'save');
});

test('Package 5.26: confirmSaveOutcome remains explicitly NOT-IMPLEMENTED, failing loudly rather than guessing', async () => {
  await assert.rejects(() => confirmSaveOutcome(), /NOT IMPLEMENTED/);
});

test('Real-run fix: answerApplyingOnBehalfOfSomeoneElse clicks the pill button bearing the real, Title-Case DOM text ("Yes"/"No"), never confused by the other', async () => {
  await page.setContent(`
    <button onclick="window.__onBehalf = 'YES'">Yes</button>
    <button onclick="window.__onBehalf = 'NO'">No</button>
  `);
  assert.equal(CONFIRMED_APPLYING_ON_BEHALF_OF_SOMEONE_ELSE_ANSWER, 'YES');

  await answerApplyingOnBehalfOfSomeoneElse(page, CONFIRMED_APPLYING_ON_BEHALF_OF_SOMEONE_ELSE_ANSWER);
  assert.equal(await page.evaluate(() => (globalThis as unknown as { __onBehalf?: string }).__onBehalf), 'YES');

  await answerApplyingOnBehalfOfSomeoneElse(page, 'NO');
  assert.equal(await page.evaluate(() => (globalThis as unknown as { __onBehalf?: string }).__onBehalf), 'NO');
});

/** Package 5.36: a complete Page 3 fixture for fillApplicantPersonalInfoFields's own direct tests -- mirrors every real, evidence-backed label, with country <select>s displaying Title Case ("Uzbekistan") to prove the case-insensitive dropdown match bridges this codebase's own UPPERCASE internal convention ("UZBEKISTAN", countryCapitalLookup.ts) without guessing. Gender/Marital Status options and the Date of Birth format match the SECOND recovered screenshot's own confirmed filled-in values ("Male"/"Married"/"15/04/1950"). */
async function setPersonalInfoFieldsFixture(): Promise<void> {
  await page.setContent(`
    <label for="nationality">Country of Nationality*</label>
    <select id="nationality"><option value="">Select</option><option>Uzbekistan</option></select>

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
    <select id="countryOfBirth"><option value="">Select</option><option>Uzbekistan</option></select>

    <label for="cityOfBirth">City of Birth*</label>
    <input type="text" id="cityOfBirth" />

    <label for="profession">Profession*</label>
    <input type="text" id="profession" />

    <p>Current Residence Address</p>
    <label for="residenceCountry">Country*</label>
    <select id="residenceCountry"><option value="">Select</option><option>Uzbekistan</option></select>
    <label for="residenceCity">City*</label>
    <input type="text" id="residenceCity" />
    <label for="residenceAddress">Address*</label>
    <input type="text" id="residenceAddress" />
  `);
}

function buildPersonalInfoFieldsInput() {
  return {
    draft: {
      portal: 'visitsaudi' as const,
      firstName: 'Jamshid',
      surname: 'Rahimov',
      dateOfBirth: '1995-05-05',
      gender: 'Erkak',
      passportNumber: 'AB1234567',
      passportIssueDate: '2020-01-01',
      passportExpiryDate: '2030-01-01',
      nationality: 'UZBEKISTAN',
      email: 'jamshid@example.test',
      arrivalDate: '2026-12-01',
      personalPortraitUrl: 'https://example.test/portrait.jpg',
    },
    maritalStatus: 'SINGLE' as const,
    countryOfBirth: 'UZBEKISTAN',
    cityOfBirth: 'Tashkent',
    countryOfResidence: 'UZBEKISTAN',
    cityOfResidence: 'Tashkent',
    profession: 'WORKER' as const,
  };
}

test('Package 5.36: fillApplicantPersonalInfoFields fills EVERY Page 3 field, including Gender/Marital Status (case-insensitive dropdown match) and Date of Birth (DD/MM/YYYY) -- no longer throws', async () => {
  await setPersonalInfoFieldsFixture();

  await fillApplicantPersonalInfoFields(page, buildPersonalInfoFieldsInput());

  const values = await page.evaluate(() => {
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
  assert.deepEqual(values, {
    nationality: 'Uzbekistan',
    firstName: 'Jamshid',
    lastName: 'Rahimov',
    gender: 'Male',
    maritalStatus: 'Single',
    dateOfBirth: '05/05/1995',
    countryOfBirth: 'Uzbekistan',
    cityOfBirth: 'Tashkent',
    profession: 'WORKER',
    residenceCountry: 'Uzbekistan',
    residenceCity: 'Tashkent',
    residenceAddress: 'TASHKENT CITY',
  });
});

test('Package 5.36: fillApplicantPersonalInfoFields throws a clear, named error (never guesses) when a country dropdown has no matching option at all', async () => {
  await page.setContent(`
    <label for="nationality">Country of Nationality*</label>
    <select id="nationality"><option value="">Select</option><option>SomeOtherCountry</option></select>
  `);

  await assert.rejects(
    () => fillApplicantPersonalInfoFields(page, buildPersonalInfoFieldsInput()),
    /no <option> matching "UZBEKISTAN" \(case-insensitive\) was found/,
  );
});

test('Package 5.33: CONFIRMED_VISIT_SAUDI_FORM_VALUES holds exactly the recovered approved-rule constants, nothing rounded or re-worded', () => {
  assert.deepEqual(CONFIRMED_VISIT_SAUDI_FORM_VALUES, {
    passportType: 'Regular Passport',
    purpose: 'UMRAH',
    alternateEmailAnswer: 'No',
    alternatePhoneAnswer: 'No',
    hotelName: 'EMAAR ELITE HOTEL MAKKA',
    currentResidenceAddress: 'TASHKENT CITY',
  });
});

/** Package 5.37: the "Passport & Trip Details" page fixture -- mirrors every evidence-backed label, PLUS two visually-identical YES/NO Communication Preference pairs and a "Primary Contact Number" field, specifically to prove fillApplicantTripDetailsFields leaves all three alone rather than guessing. */
async function setTripDetailsFixture(): Promise<void> {
  await page.setContent(`
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
    <span id="selectAllLog"></span>
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

    <script>
      window.__purposeLog = [];
      window.__commPrefLog = [];
      // page.setContent() does not create a fresh global object -- a
      // previous test's own __nav click (e.g. clickPrevious/clickNext's
      // own test) would otherwise leak into this fixture's initial
      // state, which matters now that a test here asserts __nav stays
      // undefined (Next never clicked).
      window.__nav = undefined;
    </script>
  `);
}

function buildTripDetailsFieldsInput() {
  return {
    draft: {
      portal: 'visitsaudi' as const,
      firstName: 'Jamshid',
      surname: 'Rahimov',
      dateOfBirth: '1995-05-05',
      gender: 'Erkak',
      passportNumber: 'FA8693585',
      passportIssueDate: '2023-11-12',
      passportExpiryDate: '2033-11-11',
      nationality: 'UZBEKISTAN',
      email: 'jamshid@example.test',
      arrivalDate: '2026-12-01',
      personalPortraitUrl: 'https://example.test/portrait.jpg',
    },
    countryOfBirth: 'UZBEKISTAN',
    expectedDateOfArrival: '2026-10-23',
    expectedDateOfDeparture: '2026-10-28',
  };
}

test('Package [new]: fillApplicantTripDetailsFields fills every evidence-backed field, answers BOTH Communication Preference questions correctly (email NO, phone NO, never swapped), selects ONLY UMRAH (never SELECT ALL/EVENT/FAMILY/LEISURE -- this project\'s own updated rule), deliberately leaves Primary Contact Number untouched -- against a fixture with no suggestion mechanism at all, hotelSuggestionSelected correctly comes back false, the typed hotel name is simply left in place, and this project\'s own updated rule means Next is NEVER clicked (the function stops on Page 4 rather than advance on an unconfirmed hotel selection)', async () => {
  await setTripDetailsFixture();

  const result = await fillApplicantTripDetailsFields(page, buildTripDetailsFieldsInput());
  assert.deepEqual(result, { hotelSuggestionSelected: false, advancedToNextPage: false });

  const values = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (globalThis as any).document;
    return {
      passportType: doc.getElementById('passportType').value,
      passportNo: doc.getElementById('passportNo').value,
      passportIssuePlace: doc.getElementById('passportIssuePlace').value,
      passportIssueDate: doc.getElementById('passportIssueDate').value,
      passportExpiryDate: doc.getElementById('passportExpiryDate').value,
      expectedArrival: doc.getElementById('expectedArrival').value,
      expectedDeparture: doc.getElementById('expectedDeparture').value,
      hotelName: doc.getElementById('hotelName').value,
      primaryContact: doc.getElementById('primaryContact').value,
      email: doc.getElementById('email').value,
    };
  });
  assert.deepEqual(values, {
    passportType: 'Regular Passport',
    passportNo: 'FA8693585',
    passportIssuePlace: 'UZBEKISTAN',
    passportIssueDate: '12/11/2023',
    passportExpiryDate: '11/11/2033',
    expectedArrival: '23/10/2026',
    expectedDeparture: '28/10/2026',
    hotelName: 'EMAAR ELITE HOTEL MAKKA',
    primaryContact: '', // deliberately left untouched -- see this test's own name
    email: 'jamshid@example.test',
  });

  const purposeLog = await page.evaluate(() => (globalThis as unknown as { __purposeLog: string[] }).__purposeLog);
  assert.deepEqual(
    purposeLog,
    ['UMRAH'],
    'ONLY UMRAH may be clicked -- never SELECT ALL, EVENT, FAMILY & RELATIVES, or LEISURE (this project\'s own updated rule)',
  );

  const commPrefLog = await page.evaluate(() => (globalThis as unknown as { __commPrefLog: string[] }).__commPrefLog);
  assert.deepEqual(
    commPrefLog,
    ['email:NO', 'phone:NO'],
    'the email question\'s own NO must be clicked first (confirmed document order), then the phone question\'s own NO -- never swapped, never the YES of either',
  );

  const residenceChoice = await page.evaluate(() => (globalThis as unknown as { __residenceChoice?: string }).__residenceChoice);
  assert.equal(residenceChoice, 'COMMERCIAL ACCOMMODATION');

  const nav = await page.evaluate(() => (globalThis as unknown as { __nav?: string }).__nav);
  assert.equal(nav, undefined, 'Next must NEVER be clicked when the hotel autocomplete suggestion was never found/selected');
});

test('Package [new]: fillApplicantTripDetailsFields clicks Page 4\'s Next button when (and only when) the hotel autocomplete suggestion is genuinely found and selected', async () => {
  await setTripDetailsFixture();
  // Add a real, matching suggestion element -- same convention as
  // fillHotelNameAndSelectSuggestion's own dedicated tests.
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runs in the browser; this project's own tsconfig has no "dom" lib.
    const doc = (globalThis as any).document;
    const suggestion = doc.createElement('div');
    suggestion.textContent = 'Emaar Elite Hotel, Ajyad Street, Makkah';
    doc.body.appendChild(suggestion);
  });

  const result = await fillApplicantTripDetailsFields(page, buildTripDetailsFieldsInput());
  assert.deepEqual(result, { hotelSuggestionSelected: true, advancedToNextPage: true });

  const nav = await page.evaluate(() => (globalThis as unknown as { __nav?: string }).__nav);
  assert.equal(nav, 'next', 'Next must be clicked once the hotel selection is confirmed and every field above has already been filled');
});

test('Package 5.40: clickNext matches the real, Title-Case "Next >" button (case-insensitively, anchored to the start of its text) and never the ALL-CAPS "PREVIOUS" button beside it', async () => {
  await page.setContent(`
    <button onclick="window.__nav = 'previous'">PREVIOUS</button>
    <button onclick="window.__nav = 'next'">Next &gt;</button>
  `);

  await clickNext(page);
  assert.equal(await page.evaluate(() => (globalThis as unknown as { __nav?: string }).__nav), 'next');
});

test('Package 5.40: clickNext matches regardless of casing, proving it bridges the SAME confirmed-text/unconfirmed-casing gap as this project\'s other case-insensitive matchers', async () => {
  await page.setContent(`<button onclick="window.__clicked = true">NEXT &gt;</button>`);

  await clickNext(page);
  assert.equal(await page.evaluate(() => (globalThis as unknown as { __clicked?: boolean }).__clicked), true);
});

test('Package 5.37: fillApplicantTripDetailsFields throws a clear "page not found" error, touching NOTHING, when called on a page that is not actually the Passport & Trip Details page', async () => {
  await page.setContent(`<p>Some unrelated page</p>`);

  await assert.rejects(
    () => fillApplicantTripDetailsFields(page, buildTripDetailsFieldsInput()),
    /expected to find "Passport Type".*was not visible/s,
  );
});

test('Package 5.37: confirmInsuranceConsent clicks the confirmed consent text regardless of the SAR fee amount shown, and never touches any insurance company card', async () => {
  await page.setContent(`
    <div>
      <button onclick="window.__companyClicked = true">Arabian Shield Cooperative Insurance Company</button>
    </div>
    <button onclick="window.__consentClicked = true">BY CHECKING THIS BOX I AGREE TO THE INSURANCE COVERAGE LISTED ABOVE WITH A FEE OF (95.00 SAR)</button>
  `);

  await confirmInsuranceConsent(page);

  assert.equal(await page.evaluate(() => (globalThis as unknown as { __consentClicked?: boolean }).__consentClicked), true);
  assert.equal(
    await page.evaluate(() => (globalThis as unknown as { __companyClicked?: boolean }).__companyClicked),
    undefined,
    'no insurance company card may ever be clicked',
  );
});

test('Package 5.37: confirmInsuranceConsent throws a clear "page not found" error when called on a page that is not actually the Insurance page', async () => {
  await page.setContent(`<p>Some unrelated page</p>`);

  await assert.rejects(() => confirmInsuranceConsent(page), /expected to find "INSURANCE COVERAGE".*was not visible/s);
});

test('Package 5.38: answerCommunicationPreference correctly scopes each click to its OWN question by confirmed document order, even when the email and phone answers DIFFER (never swaps which pair gets which answer)', async () => {
  await page.setContent(`
    <p>Do you want to receive the visa on a email other than your original email?</p>
    <button onclick="window.__log.push('email:YES')">YES</button>
    <button onclick="window.__log.push('email:NO')">NO</button>
    <p>Do you want to receive the visa on a phone number other than your original phone number?</p>
    <button onclick="window.__log.push('phone:YES')">YES</button>
    <button onclick="window.__log.push('phone:NO')">NO</button>
    <script>window.__log = [];</script>
  `);

  await answerCommunicationPreference(page, 'YES', 'NO');

  const log = await page.evaluate(() => (globalThis as unknown as { __log: string[] }).__log);
  assert.deepEqual(log, ['email:YES', 'phone:NO'], 'email\'s own YES (first "YES" in document order) and phone\'s own NO (second "NO" in document order) -- never the other pairing');
});

test('Package 5.38: isAnchorVisible resolves true when the given text is visible, and false (never throws) when it is not', async () => {
  await page.setContent(`<p>Passport Type</p>`);

  assert.equal(await isAnchorVisible(page, 'Passport Type', 500), true);
  assert.equal(await isAnchorVisible(page, 'Something Else Entirely', 500), false);
});

/**
 * Package 5.39 -- a minimal, hand-built autocomplete simulation: typing
 * into the Hotel field dynamically renders zero or more clickable
 * suggestion elements (never real portal markup, since that has never
 * been observed), each of which, when clicked, replaces the input's own
 * value with that suggestion's own full text -- exactly like a real
 * autocomplete widget. `window.__suggestionsClicked` records every
 * suggestion actually clicked, so a test can assert NOTHING or the ONE
 * correct suggestion was ever clicked.
 */
async function setHotelAutocompleteFixture(suggestions: string[]): Promise<void> {
  await page.setContent(`
    <label for="hotelName">Name of Hotel*</label>
    <input type="text" id="hotelName" />
    <div id="suggestions"></div>
    <script>
      window.__suggestionsClicked = [];
      const suggestions = ${JSON.stringify(suggestions)};
      document.getElementById('hotelName').addEventListener('input', () => {
        const container = document.getElementById('suggestions');
        container.innerHTML = '';
        for (const s of suggestions) {
          const div = document.createElement('div');
          div.textContent = s;
          div.onclick = () => {
            window.__suggestionsClicked.push(s);
            document.getElementById('hotelName').value = s;
          };
          container.appendChild(div);
        }
      });
    </script>
  `);
  // Defensive, explicit reset -- empirically, this Playwright version's
  // page.setContent (document.open/write/close under the hood) can
  // resolve its own promise slightly before a same-run's inline <script>
  // reset has actually re-executed, which otherwise leaks the PREVIOUS
  // test's __suggestionsClicked array into this one. This is a quirk of
  // this test fixture's own tracking variable only -- it has no bearing
  // on fillHotelNameAndSelectSuggestion's real behavior, which never
  // reads or depends on this variable; it only queries live page state.
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__suggestionsClicked = [];
  });
}

test('Package 5.39: fillHotelNameAndSelectSuggestion clicks the ONE real suggestion whose own text contains every word of the expected hotel name, even though that suggestion\'s own text is LONGER and DIFFERENT from what was typed -- matching the real recovered screenshot (typed "EMAAR ELITE HOTEL MAKKA", selected value became "Emaar Elite Hotel, Ajyad Street, Makkah") -- and NEVER clicks either of the two unrelated decoy hotels present in the same list', async () => {
  await setHotelAutocompleteFixture(['Some Unrelated Hotel', 'Emaar Elite Hotel, Ajyad Street, Makkah', 'Another Random Hotel']);

  const selected = await fillHotelNameAndSelectSuggestion(page, 'EMAAR ELITE HOTEL MAKKA');
  assert.equal(selected, true);

  const clicked = await page.evaluate(() => (globalThis as unknown as { __suggestionsClicked: string[] }).__suggestionsClicked);
  assert.deepEqual(clicked, ['Emaar Elite Hotel, Ajyad Street, Makkah'], 'only the matching suggestion may ever be clicked, never an unrelated hotel');

  const inputValue = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).document.getElementById('hotelName').value;
  });
  assert.equal(inputValue, 'Emaar Elite Hotel, Ajyad Street, Makkah');
});

test('Package 5.39: fillHotelNameAndSelectSuggestion never clicks anything when only unrelated decoy hotels are present -- resolves false, and the typed name is simply left as typed', async () => {
  await setHotelAutocompleteFixture(['Some Unrelated Hotel', 'Another Random Hotel']);

  const selected = await fillHotelNameAndSelectSuggestion(page, 'EMAAR ELITE HOTEL MAKKA', 500);
  assert.equal(selected, false);

  const clicked = await page.evaluate(() => (globalThis as unknown as { __suggestionsClicked: string[] }).__suggestionsClicked);
  assert.deepEqual(clicked, []);

  const inputValue = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).document.getElementById('hotelName').value;
  });
  assert.equal(inputValue, 'EMAAR ELITE HOTEL MAKKA', 'the typed name must still be present in the input when no suggestion is ever clicked');
});

test('Package 5.39: fillHotelNameAndSelectSuggestion resolves false (never throws) when no suggestion mechanism exists at all', async () => {
  await setHotelAutocompleteFixture([]);

  const selected = await fillHotelNameAndSelectSuggestion(page, 'EMAAR ELITE HOTEL MAKKA', 500);
  assert.equal(selected, false);
});
