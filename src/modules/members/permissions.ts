/**
 * Who may do what with member records (architecture doc, "Security and
 * controls"): the secretary manages members; admin and president may too.
 * Any staff role can look members up. A member signing in sees only their
 * own records, which arrives with the member view later.
 *
 * Field collectors will be limited to their assigned members once
 * assignment exists (M6); until then they see the list like other staff.
 */

const MANAGERS = new Set(["admin", "president", "secretary"]);
const STAFF = new Set(["admin", "president", "secretary", "cashier", "field_collector"]);

export function canManageMembers(roles: readonly string[]): boolean {
  return roles.some((r) => MANAGERS.has(r));
}

export function canViewMembers(roles: readonly string[]): boolean {
  return roles.some((r) => STAFF.has(r));
}

/**
 * Taking money from a member (share purchases now, deposits later) is the
 * cashier's job. The architecture's role table keeps admin and president
 * out of posting; one person may still hold the cashier role as well.
 */
export function canRecordPayments(roles: readonly string[]): boolean {
  return roles.includes("cashier");
}
