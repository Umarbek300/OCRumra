-- Purely additive: reserves a place for the stable tab identifier (gid) a
-- group's row/tab will have once it lives inside the shared master
-- Google Spreadsheet, instead of its own dedicated spreadsheet file.
-- NULL means "still on the legacy one-spreadsheet-per-group model" -- the
-- state of every existing row until a future, separate change starts
-- populating it. No backfill, no default, no other column touched.
ALTER TABLE groups
  ADD COLUMN google_sheet_gid INTEGER NULL;
