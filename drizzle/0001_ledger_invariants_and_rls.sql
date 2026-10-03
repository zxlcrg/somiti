-- Ledger invariants, append-only rules, row-level security and grants.
--
-- Runs as the owner role (somiti_owner). The app connects as somiti_app,
-- which owns nothing and has no BYPASSRLS; see docker/postgres/init.sql.
--
-- Custom error codes (SQLSTATE class "SM"), mapped to LedgerError in
-- src/modules/ledger/errors.ts:
--   SM001 entry unbalanced          SM005 date after the business date
--   SM002 append-only violation     SM006 unknown tenant
--   SM003 date in a closed day      SM007 account not postable
--   SM004 no open fiscal period

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Bangla names sort the way Bangla readers expect.
ALTER TABLE tenant ALTER COLUMN name_bn TYPE text COLLATE "bn-x-icu";
ALTER TABLE branch ALTER COLUMN name_bn TYPE text COLLATE "bn-x-icu";
ALTER TABLE app_user ALTER COLUMN name_bn TYPE text COLLATE "bn-x-icu";
ALTER TABLE ledger_account ALTER COLUMN name_bn TYPE text COLLATE "bn-x-icu";

-- Fiscal periods of one somiti never overlap, so every date has at most one period.
ALTER TABLE fiscal_period ADD CONSTRAINT fiscal_period_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, daterange(start_date, end_date, '[]') WITH &&);

------------------------------------------------------------------------------
-- Current tenant
------------------------------------------------------------------------------

-- The app sets this per transaction with set_config('app.tenant_id', id, true).
-- After a transaction ends, a pooled connection reports '' rather than NULL,
-- so NULLIF keeps a stale connection from erroring or matching anything.
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

------------------------------------------------------------------------------
-- Append-only tables
------------------------------------------------------------------------------

CREATE FUNCTION forbid_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; post a reversal instead', TG_TABLE_NAME
    USING ERRCODE = 'SM002';
END
$$;

CREATE TRIGGER journal_entry_append_only BEFORE UPDATE OR DELETE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_entry_no_truncate BEFORE TRUNCATE ON journal_entry
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_line_append_only BEFORE UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_line_no_truncate BEFORE TRUNCATE ON journal_line
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER idempotency_key_append_only BEFORE UPDATE OR DELETE ON idempotency_key
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

------------------------------------------------------------------------------
-- Posting rules on journal_entry
------------------------------------------------------------------------------

CREATE FUNCTION journal_entry_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  t tenant%ROWTYPE;
BEGIN
  -- The database, not the caller, decides when and in which transaction an entry was made.
  NEW.created_at := now();
  NEW.created_txid := txid_current();

  -- FOR SHARE makes a concurrent day-end close wait until this posting commits.
  SELECT * INTO t FROM tenant WHERE id = NEW.tenant_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown tenant %', NEW.tenant_id USING ERRCODE = 'SM006';
  END IF;

  IF t.locked_through IS NOT NULL AND NEW.business_date <= t.locked_through THEN
    RAISE EXCEPTION 'business date % is closed (closed through %)', NEW.business_date, t.locked_through
      USING ERRCODE = 'SM003';
  END IF;

  IF NEW.business_date > t.business_date THEN
    RAISE EXCEPTION 'business date % is after the current business date %', NEW.business_date, t.business_date
      USING ERRCODE = 'SM005';
  END IF;

  PERFORM 1 FROM fiscal_period p
   WHERE p.tenant_id = NEW.tenant_id
     AND p.status = 'open'
     AND NEW.business_date BETWEEN p.start_date AND p.end_date
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open fiscal period contains %', NEW.business_date
      USING ERRCODE = 'SM004';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER journal_entry_before_insert BEFORE INSERT ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION journal_entry_before_insert();

------------------------------------------------------------------------------
-- Line rules on journal_line
------------------------------------------------------------------------------

CREATE FUNCTION journal_line_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_txid bigint;
BEGIN
  SELECT e.created_txid INTO v_txid
    FROM journal_entry e
   WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.entry_id;
  IF NOT FOUND OR v_txid <> txid_current() THEN
    RAISE EXCEPTION 'lines can only be added in the transaction that created entry %', NEW.entry_id
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

CREATE TRIGGER journal_line_before_insert BEFORE INSERT ON journal_line
  FOR EACH ROW EXECUTE FUNCTION journal_line_before_insert();

-- Debits equal credits. Checked at commit, once all lines of the entry exist.
CREATE FUNCTION journal_check_balanced() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_tenant uuid := NEW.tenant_id;
  v_entry uuid;
  n bigint;
  d numeric;
  c numeric;
BEGIN
  IF TG_TABLE_NAME = 'journal_entry' THEN
    v_entry := NEW.id;
  ELSE
    v_entry := NEW.entry_id;
  END IF;

  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    INTO n, d, c
    FROM journal_line
   WHERE tenant_id = v_tenant AND entry_id = v_entry;

  IF n < 2 OR d <> c OR d = 0 THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: % lines, debits %, credits %', v_entry, n, d, c
      USING ERRCODE = 'SM001';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journal_entry_balanced AFTER INSERT ON journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_check_balanced();
CREATE CONSTRAINT TRIGGER journal_line_balanced AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_check_balanced();

------------------------------------------------------------------------------
-- Business date and period guards
------------------------------------------------------------------------------

CREATE FUNCTION tenant_guard_dates() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.locked_through IS NOT NULL
     AND (NEW.locked_through IS NULL OR NEW.locked_through < OLD.locked_through) THEN
    RAISE EXCEPTION 'a closed business day cannot be reopened' USING ERRCODE = 'SM003';
  END IF;
  IF NEW.business_date < OLD.business_date THEN
    RAISE EXCEPTION 'the business date cannot move backwards' USING ERRCODE = 'SM005';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tenant_guard_dates BEFORE UPDATE ON tenant
  FOR EACH ROW EXECUTE FUNCTION tenant_guard_dates();

CREATE FUNCTION fiscal_period_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
    RAISE EXCEPTION 'a closed fiscal period cannot be reopened' USING ERRCODE = 'SM003';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER fiscal_period_guard BEFORE UPDATE ON fiscal_period
  FOR EACH ROW EXECUTE FUNCTION fiscal_period_guard();

------------------------------------------------------------------------------
-- Row-level security: every tenant table, enforced even for the owner.
------------------------------------------------------------------------------

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'branch', 'app_user', 'user_role', 'idempotency_key', 'ledger_account',
    'fiscal_period', 'entry_counter', 'journal_entry', 'journal_line', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      tbl);
  END LOOP;
END
$$;

------------------------------------------------------------------------------
-- Grants for the app role. No UPDATE or DELETE on ledger or audit tables.
------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO somiti_app;

GRANT SELECT, INSERT ON journal_entry, journal_line, audit_log, idempotency_key TO somiti_app;
GRANT SELECT, INSERT, UPDATE ON entry_counter TO somiti_app;
GRANT SELECT, INSERT, DELETE ON user_role TO somiti_app;
GRANT SELECT, INSERT ON tenant, branch, app_user, ledger_account, fiscal_period TO somiti_app;

GRANT UPDATE (slug, name_en, name_bn, default_locale, fiscal_year_start_month, business_date, locked_through)
  ON tenant TO somiti_app;
GRANT UPDATE (code, name_en, name_bn) ON branch TO somiti_app;
GRANT UPDATE (branch_id, name_en, name_bn, phone, locale, is_active) ON app_user TO somiti_app;
GRANT UPDATE (name_en, name_bn, parent_id, is_active) ON ledger_account TO somiti_app;
GRANT UPDATE (status, closed_at, closed_by) ON fiscal_period TO somiti_app;
