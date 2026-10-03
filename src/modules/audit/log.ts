import type { TenantTx } from "@/db/client";
import { auditLog } from "@/db/schema";

export interface AuditRecord {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  device?: string;
}

/** JSON can't hold bigint; store amounts as strings. */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** Appends to the audit log in the caller's transaction. */
export async function recordAudit({ tx, tenantId }: TenantTx, record: AuditRecord): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId,
    actorUserId: record.actorUserId,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    before: jsonSafe(record.before),
    after: jsonSafe(record.after),
    device: record.device,
  });
}
