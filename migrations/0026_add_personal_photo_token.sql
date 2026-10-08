-- Dedicated, cryptographically random public token for the applicant-photo
-- URL (see src/visa/generateApplicantPhotoToken.ts), replacing the earlier
-- design that used telegram_message_id directly as the URL token --
-- telegram_message_id is already exposed elsewhere (Sheet column M, other
-- DB rows), so it is not a fresh secret; this column is. Generated
-- server-side ONLY at the moment a photo upload actually succeeds (see
-- performPassportOcr.ts), stored alongside personal_photo_object_path.
--
-- NULL means no photo has been uploaded yet, same convention as
-- personal_photo_object_path. The partial UNIQUE index (not a plain
-- UNIQUE constraint) is deliberate: multiple NULLs must coexist freely for
-- every pre-upload/not-yet-configured row, while any two actually-issued
-- tokens must never collide -- and it doubles as the index
-- applicantPhotoRoute.ts's lookup needs.
ALTER TABLE passport_ocr_results ADD COLUMN personal_photo_token TEXT;

CREATE UNIQUE INDEX idx_passport_ocr_results_personal_photo_token
  ON passport_ocr_results (personal_photo_token)
  WHERE personal_photo_token IS NOT NULL;
