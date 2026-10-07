ALTER TYPE "public"."share_txn_kind" ADD VALUE 'opening';--> statement-breakpoint
ALTER TYPE "public"."savings_txn_kind" ADD VALUE 'opening';--> statement-breakpoint
ALTER TABLE "share_transaction" ALTER COLUMN "payment_method" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "savings_transaction" ALTER COLUMN "payment_method" DROP NOT NULL;
