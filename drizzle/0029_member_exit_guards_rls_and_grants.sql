-- Member exits: final decisions, append-only payouts, RLS and grants.
--
-- Runs as somiti_owner. Reuses SM002 (append-only, 0001's forbid_change) and
-- SM020 (already decided, 0011). Approving or rejecting your own request
-- fails on the CHECK constraint member_exit_checker_not_maker.

CREATE FUNCTION member_exit_guard_decision() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'member exit % is already %', OLD.id, OLD.status USING ERRCODE = 'SM020';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.member_id <> OLD.member_id
     OR NEW.reason <> OLD.reason OR NEW.payment_method <> OLD.payment_method
     OR NEW.payment_ref IS DISTINCT FROM OLD.payment_ref
     OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at
     OR NEW.submit_key IS DISTINCT FROM OLD.submit_key THEN
    RAISE EXCEPTION 'only the decision on member exit % can change', OLD.id USING ERRCODE = 'SM002';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER member_exit_guard_decision BEFORE UPDATE ON member_exit
  FOR EACH ROW EXECUTE FUNCTION member_exit_guard_decision();
--> statement-breakpoint
CREATE TRIGGER member_exit_no_delete BEFORE DELETE ON member_exit
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER member_exit_no_truncate BEFORE TRUNCATE ON member_exit
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER member_exit_payout_append_only BEFORE UPDATE OR DELETE ON member_exit_payout
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER member_exit_payout_no_truncate BEFORE TRUNCATE ON member_exit_payout
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint

ALTER TABLE member_exit ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member_exit FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON member_exit
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
ALTER TABLE member_exit_payout ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member_exit_payout FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON member_exit_payout
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint

GRANT SELECT, INSERT ON member_exit, member_exit_payout TO somiti_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, decision_note, share_refund, savings_payout) ON member_exit TO somiti_app;
--> statement-breakpoint
-- An approved exit closes the member's savings accounts. Closing is the only
-- change the app makes to an account; it never reopens or deletes one.
GRANT UPDATE (status) ON savings_account TO somiti_app;
--> statement-breakpoint
CREATE FUNCTION savings_account_guard_closed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
    RAISE EXCEPTION 'savings account % is closed and cannot reopen', OLD.id USING ERRCODE = 'SM009';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER savings_account_closed_is_final BEFORE UPDATE ON savings_account
  FOR EACH ROW EXECUTE FUNCTION savings_account_guard_closed();
