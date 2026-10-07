-- Share transactions: append-only like the ledger, RLS, grants.
--
-- Runs as somiti_owner. forbid_change() is 0001's append-only guard (SM002).

CREATE TRIGGER share_transaction_append_only BEFORE UPDATE OR DELETE ON share_transaction
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER share_transaction_no_truncate BEFORE TRUNCATE ON share_transaction
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint

ALTER TABLE share_transaction ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE share_transaction FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON share_transaction
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint

GRANT SELECT, INSERT ON share_transaction TO somiti_app;
--> statement-breakpoint
-- The share price changes only when the bylaws do; a settings screen will set it.
GRANT UPDATE (share_price) ON tenant TO somiti_app;
