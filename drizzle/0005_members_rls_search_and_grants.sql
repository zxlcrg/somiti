-- Members: row-level security, Bangla sorting, search in either script, grants.
--
-- Runs as somiti_owner, like 0001 and 0003.

-- Bangla names sort the way Bangla readers expect (as tenant and app_user in 0001).
ALTER TABLE member ALTER COLUMN name_bn TYPE text COLLATE "bn-x-icu";
--> statement-breakpoint
ALTER TABLE member ALTER COLUMN guardian_name_bn TYPE text COLLATE "bn-x-icu";
--> statement-breakpoint

------------------------------------------------------------------------------
-- Search: typing "Rahim" or "রহিম" finds the same member, on part of a name.
-- pg_trgm is a trusted extension, so the database owner may create it.
------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX member_name_en_trgm ON member USING gin (name_en gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX member_name_bn_trgm ON member USING gin (name_bn gin_trgm_ops);
--> statement-breakpoint

------------------------------------------------------------------------------
-- Row-level security, forced for the owner too
------------------------------------------------------------------------------

ALTER TABLE member ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON member
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint

------------------------------------------------------------------------------
-- Grants. No DELETE: a member who leaves is marked exited or deceased, so
-- their ledger history keeps pointing at a real row. member_no, the
-- admission record and its author never change.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON member TO somiti_app;
--> statement-breakpoint
GRANT UPDATE (
  branch_id, name_en, name_bn, guardian_relation, guardian_name_en, guardian_name_bn,
  phone, nid_cipher, nid_hash, nid_last4, date_of_birth, address, comm_locale, status
) ON member TO somiti_app;
