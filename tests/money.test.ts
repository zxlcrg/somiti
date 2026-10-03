import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toBanglaDigits, toLatinDigits } from "../src/lib/digits";
import { applyBasisPoints, mulDivRound, parseTaka, toTakaDecimal } from "../src/lib/money";
import { addDays, fiscalYearContaining, todayInDhaka } from "../src/lib/dates";
import { formatAmount, formatDate, formatTaka } from "../src/lib/format";

describe("digits", () => {
  it("converts between Bangla and Latin digits", () => {
    expect(toLatinDigits("১২৩৪৫৬৭৮৯০")).toBe("1234567890");
    expect(toBanglaDigits("1234567890")).toBe("১২৩৪৫৬৭৮৯০");
    expect(toLatinDigits("৳ ১,০০০.৫০")).toBe("৳ 1,000.50");
  });
});

describe("parseTaka", () => {
  it.each([
    ["1000", 100_000n],
    ["১০০০", 100_000n],
    ["1,00,000", 10_000_000n],
    ["১,০০,০০০.৫০", 10_000_050n],
    ["1000.5", 100_050n],
    ["৳ 1000.50", 100_050n],
    ["Tk 25", 2_500n],
    ["0.01", 1n],
    ["  42  ", 4_200n],
  ])("parses %s", (input, paisa) => {
    expect(parseTaka(input)).toBe(paisa);
  });

  it.each(["", "-5", "1.234", "abc", "1e3", "1..2", "."])("rejects %s", (input) => {
    expect(parseTaka(input)).toBeNull();
  });

  it("round-trips any amount through its decimal form, in either script", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), (paisa) => {
        expect(parseTaka(toTakaDecimal(paisa))).toBe(paisa);
        expect(parseTaka(toBanglaDigits(toTakaDecimal(paisa)))).toBe(paisa);
      }),
    );
  });
});

describe("rounding", () => {
  it("rounds half away from zero", () => {
    expect(mulDivRound(5n, 1n, 10n)).toBe(1n); // 0.5 -> 1
    expect(mulDivRound(4n, 1n, 10n)).toBe(0n); // 0.4 -> 0
    expect(mulDivRound(15n, 1n, 10n)).toBe(2n); // 1.5 -> 2
    expect(mulDivRound(25n, 1n, 10n)).toBe(3n); // 2.5 -> 3 (not banker's 2)
    expect(mulDivRound(-5n, 1n, 10n)).toBe(-1n);
    expect(mulDivRound(5n, 1n, -10n)).toBe(-1n);
  });

  it("is within half a paisa of the exact result", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 100_000n }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        (a, b, c) => {
          const r = mulDivRound(a, b, c);
          // |r*c - a*b| <= c/2, compared in integers.
          const diff = r * c - a * b;
          expect((diff < 0n ? -diff : diff) * 2n <= c).toBe(true);
        },
      ),
    );
  });

  it("applies basis points", () => {
    // 12% of ৳10,000.00 = ৳1,200.00
    expect(applyBasisPoints(1_000_000n, 1_200n)).toBe(120_000n);
    // 12.5% of ৳0.03 = 0.375 paisa -> 0
    expect(applyBasisPoints(3n, 1_250n)).toBe(0n);
  });
});

describe("dates", () => {
  it("finds the July to June fiscal year", () => {
    expect(fiscalYearContaining("2026-10-03", 7)).toEqual({ startDate: "2026-07-01", endDate: "2027-06-30" });
    expect(fiscalYearContaining("2027-06-30", 7)).toEqual({ startDate: "2026-07-01", endDate: "2027-06-30" });
    expect(fiscalYearContaining("2026-06-30", 7)).toEqual({ startDate: "2025-07-01", endDate: "2026-06-30" });
    expect(fiscalYearContaining("2026-03-01", 1)).toEqual({ startDate: "2026-01-01", endDate: "2026-12-31" });
  });

  it("adds days across month, year and leap-day boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(() => addDays("2026-02-30", 1)).toThrow();
  });

  it("uses the Dhaka calendar day", () => {
    // 20:00 UTC on 3 Oct is 02:00 on 4 Oct in Dhaka.
    expect(todayInDhaka(new Date("2026-10-03T20:00:00Z"))).toBe("2026-10-04");
  });
});

describe("formatting", () => {
  it("groups in lakh and crore in both languages", () => {
    expect(formatAmount(1_234_567_890n, "en")).toBe("1,23,45,678.90");
    expect(formatAmount(1_234_567_890n, "bn")).toBe("১,২৩,৪৫,৬৭৮.৯০");
    expect(formatTaka(10_000_000n, "en")).toBe("৳1,00,000.00");
    expect(formatTaka(-5n, "bn")).toBe("-৳০.০৫");
  });

  it("formats amounts exactly beyond float precision", () => {
    expect(formatAmount(900_719_925_474_099_312n, "en")).toBe("9,00,71,99,25,47,40,993.12") // 2^53 + 1 taka;
  });

  it("formats dates in either language", () => {
    expect(formatDate("2026-10-03", "en")).toBe("3 October 2026");
    expect(formatDate("2026-10-03", "bn")).toBe("৩ অক্টোবর, ২০২৬");
  });
});
