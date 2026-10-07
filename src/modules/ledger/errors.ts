export type LedgerErrorCode =
  | "INVALID_INPUT"
  | "UNBALANCED"
  | "APPEND_ONLY"
  | "DAY_CLOSED"
  | "NO_OPEN_PERIOD"
  | "AFTER_BUSINESS_DATE"
  | "WRONG_BUSINESS_DATE"
  | "UNKNOWN_TENANT"
  | "ACCOUNT_NOT_POSTABLE"
  | "NOT_FOUND"
  | "ALREADY_REVERSED"
  | "CANNOT_REVERSE_REVERSAL"
  | "IDEMPOTENCY_CONFLICT"
  | "SELF_APPROVAL"
  | "VOUCHER_DECIDED"
  | "NOT_MAKER";

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LedgerError";
  }
}

/** SQLSTATEs raised by the invariants migrations (drizzle/0001_*.sql, 0011_*.sql). */
const SQLSTATE_CODES: Record<string, LedgerErrorCode> = {
  SM001: "UNBALANCED",
  SM002: "APPEND_ONLY",
  SM003: "DAY_CLOSED",
  SM004: "NO_OPEN_PERIOD",
  SM005: "AFTER_BUSINESS_DATE",
  SM006: "UNKNOWN_TENANT",
  SM007: "ACCOUNT_NOT_POSTABLE",
  SM020: "VOUCHER_DECIDED",
};

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

function findPgError(err: unknown): PgErrorLike | undefined {
  // Drizzle wraps driver errors; the pg error is somewhere down the cause chain.
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const candidate = current as PgErrorLike & { cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) return candidate;
    current = candidate.cause;
  }
  return undefined;
}

/** Maps a database rule violation to a LedgerError. Returns undefined for anything else. */
export function translateDbError(err: unknown): LedgerError | undefined {
  if (err instanceof LedgerError) return err;
  const pgError = findPgError(err);
  if (!pgError?.code) return undefined;
  const code = SQLSTATE_CODES[pgError.code];
  if (code) return new LedgerError(code, pgError.message ?? code, { cause: err });
  if (pgError.code === "23505" && pgError.constraint === "journal_entry_reverses_once") {
    return new LedgerError("ALREADY_REVERSED", "This entry has already been reversed", { cause: err });
  }
  if (pgError.code === "23514" && pgError.constraint === "voucher_checker_not_maker") {
    return new LedgerError("SELF_APPROVAL", "A voucher must be approved by someone other than its maker", { cause: err });
  }
  return undefined;
}
