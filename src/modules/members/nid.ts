import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { toLatinDigits } from "@/lib/digits";

/**
 * National ID numbers are personal data: stored encrypted (AES-256-GCM),
 * with an HMAC per somiti so a duplicate can be refused without decrypting,
 * and the last four digits in clear for display.
 */

const DEV_KEY_SEED = "somiti-dev-only-member-data-key";

function dataKey(): Buffer {
  const configured = process.env.MEMBER_DATA_KEY;
  if (configured) {
    const key = Buffer.from(configured, "base64url");
    if (key.length !== 32) throw new Error("MEMBER_DATA_KEY must be 32 bytes, base64url-encoded");
    return key;
  }
  if (process.env.NODE_ENV === "production") throw new Error("MEMBER_DATA_KEY is not set");
  return createHash("sha256").update(DEV_KEY_SEED).digest();
}

/** Smart cards have 10 digits; older cards 13, or 17 with the birth year in front. */
export function normalizeNid(input: string): string | null {
  const digits = toLatinDigits(input).replace(/[\s-]/g, "");
  return /^(\d{10}|\d{13}|\d{17})$/.test(digits) ? digits : null;
}

export interface SealedNid {
  nidCipher: string;
  nidHash: string;
  nidLast4: string;
}

export function sealNid(tenantId: string, nid: string): SealedNid {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  const body = Buffer.concat([cipher.update(nid, "utf8"), cipher.final()]);
  return {
    nidCipher: ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join("."),
    nidHash: nidLookupHash(tenantId, nid),
    nidLast4: nid.slice(-4),
  };
}

export function nidLookupHash(tenantId: string, nid: string): string {
  return createHmac("sha256", dataKey()).update(`${tenantId}:${nid}`).digest("hex");
}

export function openNid(sealed: string): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unknown NID format");
  const decipher = createDecipheriv("aes-256-gcm", dataKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
