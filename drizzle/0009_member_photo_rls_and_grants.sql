-- Member photos: removed is final, RLS, grants.
--
-- Runs as somiti_owner. Reuses SM009 from 0007 for "a removed record can't change".

CREATE FUNCTION member_photo_guard_removed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'member photo % was removed and cannot change', OLD.id USING ERRCODE = 'SM009';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER member_photo_removed_is_final BEFORE UPDATE ON member_photo
  FOR EACH ROW EXECUTE FUNCTION member_photo_guard_removed();
--> statement-breakpoint

ALTER TABLE member_photo ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member_photo FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON member_photo
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint

-- The app adds photos and marks them removed; it never edits or deletes one.
GRANT SELECT, INSERT ON member_photo TO somiti_app;
--> statement-breakpoint
GRANT UPDATE (removed_at, removed_by) ON member_photo TO somiti_app;
