-- Correcting a member transaction: decided once, by someone other than who
-- asked; at most one request waits per entry. RLS and narrow grants.
--
-- Runs as somiti_owner. Reuses SM002 (append-only) and SM020 (already decided).

CREATE FUNCTION entry_correction_guard_decision() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'correction % is already %', OLD.id, OLD.status USING ERRCODE = 'SM020';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.entry_id <> OLD.entry_id
     OR NEW.kind <> OLD.kind OR NEW.reason <> OLD.reason OR NEW.requested_by <> OLD.requested_by
     OR NEW.requested_on <> OLD.requested_on OR NEW.created_at <> OLD.created_at
     OR NEW.submit_key <> OLD.submit_key THEN
    RAISE EXCEPTION 'only the decision on correction % can change', OLD.id USING ERRCODE = 'SM002';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER entry_correction_guard_decision BEFORE UPDATE ON entry_correction
  FOR EACH ROW EXECUTE FUNCTION entry_correction_guard_decision();
--> statement-breakpoint
CREATE TRIGGER entry_correction_no_delete BEFORE DELETE ON entry_correction
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER entry_correction_no_truncate BEFORE TRUNCATE ON entry_correction
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE UNIQUE INDEX entry_correction_one_pending ON entry_correction (tenant_id, entry_id) WHERE status = 'pending';
--> statement-breakpoint
ALTER TABLE entry_correction ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE entry_correction FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON entry_correction
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON entry_correction TO somiti_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, decision_note, reversal_id) ON entry_correction TO somiti_app;
