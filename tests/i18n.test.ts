import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import bn from "../messages/bn.json";
import { compareMessages } from "../src/i18n/check-messages";
import { resolveLocale } from "../src/i18n/config";
import type { LedgerErrorCode } from "../src/modules/ledger";

describe("translations", () => {
  it("have the same keys and placeholders in English and Bangla", () => {
    expect(compareMessages(en, bn)).toEqual([]);
  });

  it("catch a missing key", () => {
    expect(compareMessages({ a: "x", b: { c: "{n} y" } }, { a: "x", b: {} })).toEqual(["b.c is missing from bn"]);
    expect(compareMessages({ a: "{date}" }, { a: "{day}" })).toEqual(["a has different placeholders in en and bn"]);
  });

  it("cover every ledger error code", () => {
    const codes: Record<LedgerErrorCode, true> = {
      INVALID_INPUT: true,
      UNBALANCED: true,
      APPEND_ONLY: true,
      DAY_CLOSED: true,
      NO_OPEN_PERIOD: true,
      AFTER_BUSINESS_DATE: true,
      WRONG_BUSINESS_DATE: true,
      UNKNOWN_TENANT: true,
      ACCOUNT_NOT_POSTABLE: true,
      NOT_FOUND: true,
      ALREADY_REVERSED: true,
      CANNOT_REVERSE_REVERSAL: true,
      IDEMPOTENCY_CONFLICT: true,
      SELF_APPROVAL: true,
      VOUCHER_DECIDED: true,
      NOT_MAKER: true,
    };
    expect(Object.keys(en.ledger.errors).sort()).toEqual(Object.keys(codes).sort());
  });
});

describe("language settings", () => {
  it("uses a person's own language, else the somiti default", () => {
    expect(resolveLocale("bn", "en")).toBe("bn");
    expect(resolveLocale(null, "en")).toBe("en");
    expect(resolveLocale(undefined, "bn")).toBe("bn");
  });
});
