-- Savings: RLS, append-only deposits, narrow grants.
--
-- Runs as somiti_owner. forbid_change() is 0001's append-only guard (SM002).

CREATE TRIGGER savings_transaction_append_only BEFORE UPDATE OR DELETE ON savings_transaction
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER savings_transaction_no_truncate BEFORE TRUNCATE ON savings_transaction
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
-- Accounts and products are kept for history: closed or switched off, never removed.
CREATE TRIGGER savings_account_no_delete BEFORE DELETE ON savings_account
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER savings_product_no_delete BEFORE DELETE ON savings_product
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint

ALTER TABLE savings_product ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE savings_product FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON savings_product
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
ALTER TABLE savings_account ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE savings_account FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON savings_account
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
ALTER TABLE savings_transaction ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE savings_transaction FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON savings_transaction
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint

GRANT SELECT, INSERT ON savings_product, savings_account, savings_transaction TO somiti_app;
--> statement-breakpoint
-- A product's code and schedule stay fixed once accounts use it; names and switching off may change.
GRANT UPDATE (name_en, name_bn, min_deposit, active) ON savings_product TO somiti_app;
