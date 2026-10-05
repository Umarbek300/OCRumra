-- Stable GCS object path for the applicant's personal photo, uploaded by
-- performPassportOcr.ts (see src/visa/uploadApplicantPhoto.ts), keyed by
-- telegram_message_id -- never a public URL (which would need periodic
-- re-signing) and never a bucket-qualified gs:// URI, so the bucket name
-- itself never leaks into application data read back out of this table.
-- NULL means no photo has been uploaded yet (photo storage not configured
-- in this environment, or the upload attempt failed) -- every reader of
-- this column (syncPassportRowToSheet.ts, the /visa-photos/:token route)
-- must treat NULL as "nothing to do yet", never as an error.
ALTER TABLE passport_ocr_results ADD COLUMN personal_photo_object_path TEXT;
