-- kind is compared as text: a new enum value can't be used in the transaction that added it.
ALTER TABLE "share_transaction" ADD CONSTRAINT "share_transaction_opening_unpaid" CHECK (("share_transaction"."kind"::text = 'opening') = ("share_transaction"."payment_method" IS NULL));--> statement-breakpoint
ALTER TABLE "savings_transaction" ADD CONSTRAINT "savings_transaction_opening_unpaid" CHECK (("savings_transaction"."kind"::text = 'opening') = ("savings_transaction"."payment_method" IS NULL));
