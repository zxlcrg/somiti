-- SMS outbox: RLS, no deletes, and only delivery columns may change.
--
-- Runs as somiti_owner.

CREATE FUNCTION sms_outbox_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'sent' THEN
    RAISE EXCEPTION 'a sent message cannot change' USING ERRCODE = 'SM002';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sms_outbox_guard BEFORE UPDATE ON sms_outbox
  FOR EACH ROW EXECUTE FUNCTION sms_outbox_guard();
--> statement-breakpoint
CREATE TRIGGER sms_outbox_no_delete BEFORE DELETE ON sms_outbox
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER sms_outbox_no_truncate BEFORE TRUNCATE ON sms_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
ALTER TABLE sms_outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sms_outbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sms_outbox
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON sms_outbox TO somiti_app;
--> statement-breakpoint
GRANT UPDATE (status, attempts, last_error, sent_at) ON sms_outbox TO somiti_app;
