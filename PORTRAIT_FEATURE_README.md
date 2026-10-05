# Portrait feature — standalone branch

This branch is based on `114909e` (tip of `claude/wonderful-faraday-narsp0` at the
time this branch was cut) and contains **only** the portrait-crop feature,
deliberately excluding the already-deployed original-photo feature (T-column),
the confirmation-crash-safety fix, and every other unrelated change.

## What's committed as real code here

These files are **100% new** — they need no pre-existing baseline to exist
correctly, so they're committed as actual working code, unmodified from the
sandbox implementation:

- `migrations/0027_add_personal_portrait_fields.sql`
- `src/visa/extractApplicantPhotoCrop.ts`
- `src/visa/computeApplicantPhotoCropRegion.ts`
- `tests/visa.extractApplicantPhotoCrop.test.ts`
- `tests/visa.computeApplicantPhotoCropRegion.test.ts`

## What's included as a patch file instead, and why

`portrait-feature.patch` (also in this commit) contains unified diffs for the
remaining portrait changes — to:

- `src/db/repositories/passportOcrResult.repo.ts`
- `src/worker/performPassportOcr.ts`
- `src/sheets/syncPassportRowToSheet.ts`
- `src/visa/visaSheetColumns.ts`
- `src/visa/uploadApplicantPhoto.ts` (adds `uploadApplicantPortrait`)
- `src/visa/applicantPhotoRoute.ts` (adds portrait-token disambiguation)
- `src/visa/writePersonalPhotoUrlIfBlank.ts` (generalizes to a `column` param)
- `tests/passportOcrResult.repo.test.ts`, `tests/performPassportOcr.test.ts`,
  `tests/sheets.syncPassportRowToSheet.test.ts`,
  `tests/sheets.reconcileSheetRow.test.ts`, `tests/sheets.runSheetSyncLoop.test.ts`
- `tests/visa.applicantPhotoRoute.test.ts`, `tests/visa.writePersonalPhotoUrlIfBlank.test.ts`

These are diffs against each file's state **after** the original-photo feature
(T-column) is already applied — since that feature isn't committed anywhere in
this repo's git history, materializing these files directly here would mean
guessing/reconstructing their current pre-portrait content, which risks
silently diverging from whatever is actually deployed in production. The patch
is verified to `git apply --check` cleanly once applied on top of a tree that
already has the original-photo feature (confirmed by reconstructing that
baseline and checking in a disposable worktree — see the prior diagnosis in
this session). Apply it directly against the real production/base branch tree
once the original-photo feature is present there.

## Known external prerequisites (not part of this branch)

This patch assumes the following already exist wherever it's applied — they
are the original-photo feature's own files/config, not part of the portrait
feature itself:

- `src/visa/applicantPhotoUrl.ts` (`buildApplicantPhotoPublicUrl`)
- `src/visa/generateApplicantPhotoToken.ts` (`generateApplicantPhotoToken`)
- `env.schema.ts`'s `VISA_PHOTOS_PUBLIC_BASE_URL`, `GCS_VISA_PHOTOS_BUCKET`,
  `GCS_VISA_PHOTOS_SERVICE_ACCOUNT_KEY_FILE`
- `server.ts`'s `/visa-photos/:token` route registration

Without these, `tsc --noEmit` on the patched tree reports exactly 3 errors
(all pointing at the two missing imports and the missing env field) — no
other prerequisites are needed.
