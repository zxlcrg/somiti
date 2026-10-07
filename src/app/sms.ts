import { getAppDb, withTenant } from "@/db/client";
import { getSmsSender } from "@/modules/auth";
import { flushOutbox } from "@/modules/messages";

/**
 * Sends the somiti's queued member messages after a money movement has
 * committed. Never fails the request: anything unsent stays queued and goes
 * out with the next flush.
 */
export async function flushSms(tenantId: string): Promise<void> {
  try {
    const sender = getSmsSender();
    await withTenant(getAppDb(), tenantId, (ctx) => flushOutbox(ctx, sender));
  } catch (err) {
    console.error("[sms] flush failed:", err instanceof Error ? err.message : err);
  }
}
