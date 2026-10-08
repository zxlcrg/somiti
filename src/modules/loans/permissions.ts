/**
 * Who may do what with loans (architecture doc, "Security and controls").
 * Products are set up by the people who manage the somiti. Any officer who
 * handles members may take an application; a different managing officer
 * approves it, and the cashier pays it out.
 */

const MANAGERS = new Set(["admin", "president", "secretary"]);
const MAKERS = new Set(["admin", "president", "secretary", "cashier"]);

export function canManageLoanProducts(roles: readonly string[]): boolean {
  return roles.some((r) => MANAGERS.has(r));
}

export function canApplyForLoans(roles: readonly string[]): boolean {
  return roles.some((r) => MAKERS.has(r));
}

export function canApproveLoans(roles: readonly string[]): boolean {
  return roles.some((r) => MANAGERS.has(r));
}

export function canDisburseLoans(roles: readonly string[]): boolean {
  return roles.includes("cashier");
}

export function canViewLoans(roles: readonly string[]): boolean {
  return canApplyForLoans(roles) || roles.includes("field_collector");
}

/** Repayments are taken like savings deposits: the cashier at the office, a field collector on a round. */
export function repaymentChannel(roles: readonly string[]): "office" | "collector" | null {
  if (roles.includes("cashier")) return "office";
  if (roles.includes("field_collector")) return "collector";
  return null;
}

/** A new schedule is a credit decision, so it is made by the managing officers who approve loans. */
export function canRescheduleLoans(roles: readonly string[]): boolean {
  return canApproveLoans(roles);
}
