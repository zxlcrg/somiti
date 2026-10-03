import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const DEV_SECRET = "somiti-dev-only-auth-secret";

function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET is not set");
  return DEV_SECRET;
}

/** A six-digit code, uniformly random. */
export function newSignInCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Binds a code to its challenge, so a hash can't be replayed against another one. */
export function hashSignInCode(challengeId: string, code: string): string {
  return createHmac("sha256", authSecret()).update(`${challengeId}:${code}`).digest("hex");
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 256 random bits for the session cookie. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
