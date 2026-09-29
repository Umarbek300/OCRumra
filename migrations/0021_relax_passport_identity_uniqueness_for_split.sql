-- Relaxes passport_identity's uniqueness so an EXPLICIT identity-split
-- correction can create a second, independently-active identity sharing
-- the same (passport_number_normalized, date_of_birth) key as its origin
-- -- necessary because every automatic resolution path
-- (resolvePassportIdentity) finds an existing identity via an EXACT key
-- match, so a split-out link always shares its origin identity's exact
-- key by construction; there is no other signal to distinguish two
-- coincidentally-identical real documents. See src/duplicates/splitLink.ts.
--
-- The ORIGINAL global uniqueness guarantee (no two AUTO-created identities
-- can ever coincidentally share a key) is preserved for every normal,
-- non-split identity via a partial unique index scoped to
-- split_origin_identity_id IS NULL -- a split-created identity is the
-- ONLY kind of row exempt from this uniqueness, and only reachable via an
-- explicit, human-confirmed split action, never via automatic resolution.
--
-- Consequence, documented rather than hidden: once a split has occurred,
-- a FUTURE message that resolves to this same key will, by default, match
-- the OLDER/original identity (findPassportIdentityByKey orders by
-- created_at ASC) -- there is no OCR-derivable signal to prefer the
-- split-out identity instead. This is an accepted, explicit limitation of
-- relaxing the constraint this way, not an oversight.
ALTER TABLE passport_identity DROP CONSTRAINT passport_identity_passport_number_normalized_date_of_birth_key;

ALTER TABLE passport_identity
  ADD COLUMN split_origin_identity_id UUID REFERENCES passport_identity (id);

CREATE UNIQUE INDEX idx_passport_identity_key_unique
  ON passport_identity (passport_number_normalized, date_of_birth)
  WHERE split_origin_identity_id IS NULL;

CREATE INDEX idx_passport_identity_split_origin ON passport_identity (split_origin_identity_id)
  WHERE split_origin_identity_id IS NOT NULL;
