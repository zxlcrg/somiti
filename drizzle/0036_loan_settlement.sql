ALTER TABLE "loan_repayment" DROP CONSTRAINT "loan_repayment_amounts";--> statement-breakpoint
ALTER TABLE "loan_repayment_line" DROP CONSTRAINT "loan_repayment_line_amounts";--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "settlement_rebate_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_product" ADD COLUMN "settlement_rebate_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_repayment" ADD COLUMN "rebate" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_repayment" ADD COLUMN "settlement" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_repayment_line" ADD COLUMN "rebate" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_settlement_rebate" CHECK ("loan"."settlement_rebate_bp" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "loan_product" ADD CONSTRAINT "loan_product_settlement_rebate" CHECK ("loan_product"."settlement_rebate_bp" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "loan_repayment" ADD CONSTRAINT "loan_repayment_rebate" CHECK ("loan_repayment"."rebate" = 0 OR "loan_repayment"."settlement");--> statement-breakpoint
ALTER TABLE "loan_repayment" ADD CONSTRAINT "loan_repayment_amounts" CHECK ("loan_repayment"."amount" > 0 AND "loan_repayment"."principal" >= 0 AND "loan_repayment"."interest" >= 0 AND "loan_repayment"."fine" >= 0 AND "loan_repayment"."rebate" >= 0 AND "loan_repayment"."amount" = "loan_repayment"."principal" + "loan_repayment"."interest");--> statement-breakpoint
ALTER TABLE "loan_repayment_line" ADD CONSTRAINT "loan_repayment_line_amounts" CHECK ("loan_repayment_line"."principal" >= 0 AND "loan_repayment_line"."interest" >= 0 AND "loan_repayment_line"."rebate" >= 0 AND "loan_repayment_line"."principal" + "loan_repayment_line"."interest" + "loan_repayment_line"."rebate" > 0);