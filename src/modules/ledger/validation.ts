import { z } from "zod";

const paisa = z.bigint().positive();

export const journalLineInput = z
  .object({
    accountId: z.uuid(),
    debit: paisa.optional(),
    credit: paisa.optional(),
    memberId: z.uuid().optional(),
    savingsAccountId: z.uuid().optional(),
    loanId: z.uuid().optional(),
    memo: z.string().trim().max(500).optional(),
  })
  .refine((l) => (l.debit === undefined) !== (l.credit === undefined), {
    message: "Each line needs exactly one of debit or credit",
  });

export const postEntryInput = z
  .object({
    branchId: z.uuid(),
    /** Defaults to the somiti's current business date. */
    businessDate: z.iso.date().optional(),
    source: z.enum(["opening_balance", "manual_voucher", "share_purchase", "savings_deposit", "system"]),
    narration: z.string().trim().min(1).max(1000),
    createdBy: z.uuid(),
    /** Client-generated key; a repeat with the same key and body returns the first result. */
    idempotencyKey: z.string().min(8).max(128).optional(),
    device: z.string().max(200).optional(),
    lines: z.array(journalLineInput).min(2).max(500),
  })
  .refine(
    (e) => {
      const debits = e.lines.reduce((sum, l) => sum + (l.debit ?? 0n), 0n);
      const credits = e.lines.reduce((sum, l) => sum + (l.credit ?? 0n), 0n);
      return debits === credits;
    },
    { message: "Debits must equal credits", path: ["lines"] },
  );

export type JournalLineInput = z.infer<typeof journalLineInput>;
export type PostEntryInput = z.input<typeof postEntryInput>;

export const reverseEntryInput = z.object({
  entryId: z.uuid(),
  /** Defaults to the current business date, so a mistake in a closed day is fixed today. */
  businessDate: z.iso.date().optional(),
  reason: z.string().trim().min(1).max(1000),
  createdBy: z.uuid(),
  idempotencyKey: z.string().min(8).max(128).optional(),
  device: z.string().max(200).optional(),
});

export type ReverseEntryInput = z.input<typeof reverseEntryInput>;
