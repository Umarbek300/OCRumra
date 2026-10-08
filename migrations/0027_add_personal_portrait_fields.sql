-- Stable GCS object path + dedicated public token for the applicant's
-- CROPPED portrait (the face-detected photo region only), separate from
-- personal_photo_object_path/personal_photo_token (migrations 0025/0026),
-- which remain the ORIGINAL, full, uncropped passport image -- see
-- src/visa/extractApplicantPhotoCrop.ts and performPassportOcr.ts for the
-- crop step, and src/visa/uploadApplicantPhoto.ts's uploadApplicantPortrait
-- for the upload. Mirrors personal_photo_object_path/personal_photo_token's
-- own conventions exactly: NULL means no portrait crop/upload has happened
-- yet (no reliable face region found, photo storage not configured, or the
-- upload attempt failed) -- every reader must treat NULL as "nothing to do
-- yet", never as an error, and must never fall back to the original
-- passport image in its place.
ALTER TABLE passport_ocr_results ADD COLUMN personal_portrait_object_path TEXT;
ALTER TABLE passport_ocr_results ADD COLUMN personal_portrait_token TEXT;

CREATE UNIQUE INDEX idx_passport_ocr_results_personal_portrait_token
  ON passport_ocr_results (personal_portrait_token)
  WHERE personal_portrait_token IS NOT NULL;
