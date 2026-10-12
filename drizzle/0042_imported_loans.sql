ALTER TABLE "loan" DROP CONSTRAINT "loan_checker_not_maker";--> statement-breakpoint
ALTER TABLE "loan" DROP CONSTRAINT "loan_disbursed";--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "imported_on" date;--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "original_principal" bigint;--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "original_installments" integer;--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "paid_before" bigint;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_imported" CHECK (("loan"."imported_on" IS NULL) = ("loan"."original_principal" IS NULL)
          AND ("loan"."imported_on" IS NULL) = ("loan"."original_installments" IS NULL)
          AND ("loan"."imported_on" IS NULL) = ("loan"."paid_before" IS NULL)
          AND ("loan"."imported_on" IS NULL OR ("loan"."original_principal" >= "loan"."principal" AND "loan"."paid_before" >= 0)));--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_checker_not_maker" CHECK ("loan"."imported_on" IS NOT NULL OR "loan"."status" NOT IN ('approved', 'rejected', 'disbursed', 'closed') OR "loan"."decided_by" <> "loan"."applied_by");--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_disbursed" CHECK (("loan"."status" IN ('disbursed', 'closed')) = ("loan"."entry_id" IS NOT NULL)
          AND ("loan"."entry_id" IS NULL) = ("loan"."disbursed_on" IS NULL)
          AND ("loan"."entry_id" IS NULL) = ("loan"."disbursed_by" IS NULL)
          AND ("loan"."imported_on" IS NOT NULL OR ("loan"."entry_id" IS NULL) = ("loan"."payment_method" IS NULL)));