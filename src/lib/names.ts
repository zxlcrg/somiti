import type { Locale } from "@/i18n/config";

/** Anything with a name in one or both scripts: members, users, somitis, accounts. */
export interface BilingualName {
  nameEn: string | null;
  nameBn: string | null;
}

/** The name in the reader's script, falling back to the other one. */
export function primaryName(n: BilingualName, locale: Locale): string {
  return (locale === "bn" ? (n.nameBn ?? n.nameEn) : (n.nameEn ?? n.nameBn)) ?? "";
}

/** The other script's name, when both exist; shown under the primary one. */
export function secondaryName(n: BilingualName, locale: Locale): string | null {
  if (!n.nameEn || !n.nameBn) return null;
  return locale === "bn" ? n.nameEn : n.nameBn;
}

/** A first letter for avatars, in whichever script the primary name uses. */
export function initial(n: BilingualName, locale: Locale): string {
  return Array.from(primaryName(n, locale).trim())[0] ?? "?";
}
