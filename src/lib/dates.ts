/** Dates without a time of day are ISO strings ("2026-10-03") in Asia/Dhaka. */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parse(date: IsoDate): Date {
  if (!ISO_DATE.test(date)) throw new RangeError(`Not an ISO date: ${date}`);
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`Not a valid date: ${date}`);
  }
  return d;
}

function format(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return format(d);
}

/**
 * The same day `months` months later. A day the month doesn't have becomes
 * its last day: 31 January plus one month is 28 or 29 February.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const d = parse(date);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return format(target);
}

/** Today's date in Dhaka. */
export function todayInDhaka(now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(now);
}

/**
 * The fiscal year containing `date`, for a year that starts on the first of
 * `startMonth` (7 = July, giving July to June).
 */
export function fiscalYearContaining(
  date: IsoDate,
  startMonth: number,
): { startDate: IsoDate; endDate: IsoDate } {
  const d = parse(date);
  const year = d.getUTCMonth() + 1 >= startMonth ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const start = new Date(Date.UTC(year, startMonth - 1, 1));
  const end = new Date(Date.UTC(year + 1, startMonth - 1, 1));
  end.setUTCDate(end.getUTCDate() - 1);
  return { startDate: format(start), endDate: format(end) };
}
