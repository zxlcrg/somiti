/*
 * Splitting a repayment over the schedule. Pure, so the collection form can
 * preview exactly what the server will post.
 *
 * Money goes to the oldest installment that still has something owing, and
 * moves on only once that installment is fully paid. Inside an installment
 * the loan's allocation order decides which half is settled first. Paying
 * more than is due runs on into the next installments (an advance), up to
 * everything still owed.
 */

export type Allocation = "interest_first" | "principal_first";

export interface InstallmentState {
  seq: number;
  dueOn: string;
  principal: bigint;
  interest: bigint;
  paidPrincipal: bigint;
  paidInterest: bigint;
}

export interface AllocatedLine {
  seq: number;
  principal: bigint;
  interest: bigint;
}

export type InstallmentStatus = "paid" | "part" | "overdue" | "due" | "upcoming";

const left = (r: InstallmentState) => ({ principal: r.principal - r.paidPrincipal, interest: r.interest - r.paidInterest });

export function outstanding(rows: readonly InstallmentState[]): { principal: bigint; interest: bigint; total: bigint } {
  let principal = 0n;
  let interest = 0n;
  for (const r of rows) {
    const l = left(r);
    principal += l.principal;
    interest += l.interest;
  }
  return { principal, interest, total: principal + interest };
}

/** The split for `amount`, or null when it is not positive or more than is owed. */
export function allocate(rows: readonly InstallmentState[], amount: bigint, order: Allocation): AllocatedLine[] | null {
  if (amount <= 0n || amount > outstanding(rows).total) return null;
  const lines: AllocatedLine[] = [];
  let rest = amount;
  for (const r of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (rest === 0n) break;
    const l = left(r);
    if (l.principal + l.interest === 0n) continue;
    const firstLeft = order === "interest_first" ? l.interest : l.principal;
    const first = rest < firstLeft ? rest : firstLeft;
    rest -= first;
    const secondLeft = order === "interest_first" ? l.principal : l.interest;
    const second = rest < secondLeft ? rest : secondLeft;
    rest -= second;
    lines.push(order === "interest_first" ? { seq: r.seq, interest: first, principal: second } : { seq: r.seq, principal: first, interest: second });
  }
  return lines;
}

export function installmentStatus(r: InstallmentState, today: string): InstallmentStatus {
  const l = left(r);
  if (l.principal + l.interest === 0n) return "paid";
  if (r.dueOn < today) return "overdue";
  if (r.dueOn === today) return "due";
  return r.paidPrincipal + r.paidInterest > 0n ? "part" : "upcoming";
}

export interface Standing {
  /** Still owing on installments due today or earlier. */
  dueNow: bigint;
  /** Installments past their date and not fully paid. */
  overdueCount: number;
  /** The earliest installment with something owing, and how much. */
  next: { seq: number; dueOn: string; amount: bigint } | null;
  paidCount: number;
}

export function standing(rows: readonly InstallmentState[], today: string): Standing {
  let dueNow = 0n;
  let overdueCount = 0;
  let paidCount = 0;
  let next: Standing["next"] = null;
  for (const r of [...rows].sort((a, b) => a.seq - b.seq)) {
    const l = left(r);
    const owing = l.principal + l.interest;
    if (owing === 0n) {
      paidCount++;
      continue;
    }
    if (!next) next = { seq: r.seq, dueOn: r.dueOn, amount: owing };
    if (r.dueOn <= today) dueNow += owing;
    if (r.dueOn < today) overdueCount++;
  }
  return { dueNow, overdueCount, next, paidCount };
}

/**
 * The late fine a repayment brings with it: one fine for each installment it
 * pays into after that installment's due date, unless that installment was
 * fined (or the fine waived) before. Taken on top of the amount, like a
 * savings late fine.
 */
export function lateFineFor(
  rows: readonly InstallmentState[],
  lines: readonly AllocatedLine[],
  today: string,
  lateFine: bigint | null,
  fined: readonly number[],
): { seqs: number[]; fine: bigint } {
  if (!lateFine) return { seqs: [], fine: 0n };
  const due = new Map(rows.map((r) => [r.seq, r.dueOn]));
  const seqs = lines.filter((x) => (due.get(x.seq) ?? today) < today && !fined.includes(x.seq)).map((x) => x.seq);
  return { seqs, fine: lateFine * BigInt(seqs.length) };
}
