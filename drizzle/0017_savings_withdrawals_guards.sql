-- Savings withdrawals: final decisions, RLS and narrow grants.
--
-- Runs as somiti_owner. Reuses SM002 (append-only) from 0001 and SM020
-- (already decided) from 0011. Approving or rejecting your own request
-- fails on the CHECK constraint savings_withdrawal_checker_not_maker.

CREATE FUNCTION savings_withdrawal_guard_decision() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'withdrawal % is already %', OLD.id, OLD.status USING ERRCODE = 'SM020';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id
     OR NEW.amount <> OLD.amount OR NEW.payment_method <> OLD.payment_method
     OR NEW.payment_ref IS DISTINCT FROM OLD.payment_ref OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at
     OR NEW.submit_key IS DISTINCT FROM OLD.submit_key THEN
    RAISE EXCEPTION 'only the decision on withdrawal % can change', OLD.id USING ERRCODE = 'SM002';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER savings_withdrawal_guard_decision BEFORE UPDATE ON savings_withdrawal
  FOR EACH ROW EXECUTE FUNCTION savings_withdrawal_guard_decision();
--> statement-breakpoint
CREATE TRIGGER savings_withdrawal_no_delete BEFORE DELETE ON savings_withdrawal
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER savings_withdrawal_no_truncate BEFORE TRUNCATE ON savings_withdrawal
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint

ALTER TABLE savings_withdrawal ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE savings_withdrawal FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON savings_withdrawal
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint

GRANT SELECT, INSERT ON savings_withdrawal TO somiti_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, decision_note, entry_id) ON savings_withdrawal TO somiti_app;
