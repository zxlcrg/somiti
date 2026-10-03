-- Nominees: shares total 100%, history kept, RLS, Bangla sorting, grants.
--
-- Runs as somiti_owner. New error codes, continuing 0001's SM series:
--   SM008 a member's active nominee shares don't total 100%
--   SM009 a removed nominee can't be changed or restored

ALTER TABLE nominee ALTER COLUMN name_bn TYPE text COLLATE "bn-x-icu";
--> statement-breakpoint

------------------------------------------------------------------------------
-- Active shares of a member total exactly 100% (or 0%, with no nominees).
-- Checked at commit, so a set can be replaced row by row in one transaction.
------------------------------------------------------------------------------

CREATE FUNCTION nominee_check_shares() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  total bigint;
BEGIN
  SELECT coalesce(sum(share_bp), 0) INTO total
    FROM nominee
   WHERE tenant_id = NEW.tenant_id AND member_id = NEW.member_id AND removed_at IS NULL;
  IF total NOT IN (0, 10000) THEN
    RAISE EXCEPTION 'nominee shares of member % total % basis points, not 10000', NEW.member_id, total
      USING ERRCODE = 'SM008';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER nominee_shares_total AFTER INSERT OR UPDATE ON nominee
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nominee_check_shares();
--> statement-breakpoint

------------------------------------------------------------------------------
-- A nomination is a record of what the member asked for at the time. Once
-- removed it stays exactly as it was.
------------------------------------------------------------------------------

CREATE FUNCTION nominee_guard_removed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'nominee % was removed and cannot change', OLD.id USING ERRCODE = 'SM009';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER nominee_removed_is_final BEFORE UPDATE ON nominee
  FOR EACH ROW EXECUTE FUNCTION nominee_guard_removed();
--> statement-breakpoint

------------------------------------------------------------------------------
-- Row-level security, forced for the owner too
------------------------------------------------------------------------------

ALTER TABLE nominee ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE nominee FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON nominee
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint

------------------------------------------------------------------------------
-- Grants. The app adds nominees and marks them removed; it never edits or
-- deletes one.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON nominee TO somiti_app;
--> statement-breakpoint
GRANT UPDATE (removed_at, removed_by) ON nominee TO somiti_app;
