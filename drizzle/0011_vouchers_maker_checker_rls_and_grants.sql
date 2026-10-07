-- Manual vouchers with maker-checker: balance, append-only lines, final
-- decisions, RLS and grants.
--
-- Runs as somiti_owner. Reuses SM001 (unbalanced), SM002 (append-only) and
-- SM007 (account not postable) from 0001, and adds:
--   SM020 a voucher that was already decided can't change again
-- Approving or rejecting your own voucher fails on the CHECK constraint
-- voucher_checker_not_maker (SQLSTATE 23514).

------------------------------------------------------------------------------
-- Lines: added only with their voucher, to a postable account, never changed
------------------------------------------------------------------------------

CREATE FUNCTION voucher_line_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_txid bigint;
BEGIN
  SELECT v.created_txid INTO v_txid
    FROM voucher v
   WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.voucher_id;
  IF NOT FOUND OR v_txid <> txid_current() THEN
    RAISE EXCEPTION 'lines can only be added in the transaction that created voucher %', NEW.voucher_id
      USING ERRCODE = 'SM002';
  END IF;

  PERFORM 1 FROM ledger_account a
   WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id
     AND a.is_postable AND a.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account % is not an active postable account', NEW.account_id
      USING ERRCODE = 'SM007';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER voucher_line_before_insert BEFORE INSERT ON voucher_line
  FOR EACH ROW EXECUTE FUNCTION voucher_line_before_insert();
--> statement-breakpoint
CREATE TRIGGER voucher_line_append_only BEFORE UPDATE OR DELETE ON voucher_line
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER voucher_line_no_truncate BEFORE TRUNCATE ON voucher_line
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER voucher_no_delete BEFORE DELETE ON voucher
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER voucher_no_truncate BEFORE TRUNCATE ON voucher
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint

------------------------------------------------------------------------------
-- Balanced, with its total matching the lines. Checked at commit.
------------------------------------------------------------------------------

CREATE FUNCTION voucher_check_balanced() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_id uuid;
  v_total bigint;
  n bigint;
  d numeric;
  c numeric;
BEGIN
  IF TG_TABLE_NAME = 'voucher' THEN
    v_id := NEW.id;
  ELSE
    v_id := NEW.voucher_id;
  END IF;

  SELECT total INTO v_total FROM voucher WHERE tenant_id = NEW.tenant_id AND id = v_id;
  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    INTO n, d, c
    FROM voucher_line
   WHERE tenant_id = NEW.tenant_id AND voucher_id = v_id;

  IF n < 2 OR d <> c OR d <> v_total THEN
    RAISE EXCEPTION 'voucher % is unbalanced: % lines, debits %, credits %, total %', v_id, n, d, c, v_total
      USING ERRCODE = 'SM001';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER voucher_balanced AFTER INSERT ON voucher
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION voucher_check_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER voucher_line_balanced AFTER INSERT ON voucher_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION voucher_check_balanced();
--> statement-breakpoint

------------------------------------------------------------------------------
-- A decision is final, and only the decision columns can change.
------------------------------------------------------------------------------

CREATE FUNCTION voucher_guard_decision() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'voucher % is already %', OLD.id, OLD.status USING ERRCODE = 'SM020';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.branch_id <> OLD.branch_id
     OR NEW.narration <> OLD.narration OR NEW.total <> OLD.total OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.created_txid <> OLD.created_txid
     OR NEW.submit_key IS DISTINCT FROM OLD.submit_key THEN
    RAISE EXCEPTION 'only the decision on voucher % can change', OLD.id USING ERRCODE = 'SM002';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER voucher_guard_decision BEFORE UPDATE ON voucher
  FOR EACH ROW EXECUTE FUNCTION voucher_guard_decision();
--> statement-breakpoint

------------------------------------------------------------------------------
-- Row-level security, forced for the owner too
------------------------------------------------------------------------------

ALTER TABLE voucher ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE voucher FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON voucher
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
ALTER TABLE voucher_line ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE voucher_line FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON voucher_line
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint

------------------------------------------------------------------------------
-- Grants. The app makes vouchers and records decisions; it never edits or
-- deletes a voucher or its lines.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON voucher, voucher_line TO somiti_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, decision_note, entry_id) ON voucher TO somiti_app;
