/**
 * Who may do what with savings (architecture doc, "Security and controls").
 * Products and accounts are set up by the people who manage members.
 * Deposits are money taken in: the cashier at the office, or a field
 * collector out on their round, whose cash is theirs to hand over later.
 */

const MANAGERS = new Set(["admin", "president", "secretary"]);

export function canManageSavings(roles: readonly string[]): boolean {
  return roles.some((r) => MANAGERS.has(r));
}

export function canTakeDeposits(roles: readonly string[]): boolean {
  return roles.includes("cashier") || roles.includes("field_collector");
}

/**
 * Where a deposit's money first lands. A cashier takes it at the office
 * (cash in hand, bank or wallet); a collector holds the cash until they
 * hand it over, so it goes to Cash with collector.
 */
export function depositChannel(roles: readonly string[]): "office" | "collector" | null {
  if (roles.includes("cashier")) return "office";
  if (roles.includes("field_collector")) return "collector";
  return null;
}
