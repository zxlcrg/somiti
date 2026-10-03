import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAppDb } from "@/db/client";
import { readSession, type SessionUser } from "@/modules/auth";

export const SESSION_COOKIE = "somiti_session";
/** Remembers the somiti code typed last, so the next sign-in starts filled in. */
export const LAST_SLUG_COOKIE = "somiti_last_slug";

/** The signed-in user for this request, read once per render. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  return readSession(getAppDb(), store.get(SESSION_COOKIE)?.value);
});

/** For pages behind sign-in. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}
