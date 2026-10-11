/** Calendar helpers on local dates ("YYYY-MM-DD"); arithmetic in UTC so no time zone is involved. */

export const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober",
  "November", "Dezember"];
export const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

export type Period = "day" | "week" | "month" | "year";
export const PERIODS: Period[] = ["day", "week", "month", "year"];

const pad = (n: number) => String(n).padStart(2, "0");

export function toUtc(d: string): Date {
  return new Date(`${d}T00:00:00Z`);
}

export function fromUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function dayKeyOf(d: string): number {
  return Number(d.replaceAll("-", ""));
}

export function dateOfDayKey(key: number): string {
  const s = String(key);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function addDays(d: string, n: number): string {
  const t = toUtc(d);
  t.setUTCDate(t.getUTCDate() + n);
  return fromUtc(t);
}

export function addMonths(d: string, n: number): string {
  const t = toUtc(d);
  const day = t.getUTCDate();
  t.setUTCDate(1);
  t.setUTCMonth(t.getUTCMonth() + n);
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return fromUtc(t);
}

/** 0 = Monday. */
export function weekday(d: string): number {
  return (toUtc(d).getUTCDay() + 6) % 7;
}

export function isoWeek(d: string): number {
  const t = toUtc(d);
  t.setUTCDate(t.getUTCDate() + 3 - weekday(d)); // Thursday of this week
  const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

export function clampDate(d: string, min: string, max: string): string {
  return d < min ? min : d > max ? max : d;
}

/** Start (incl.) and end (excl.) of the period containing d. */
export function periodRange(period: Period, d: string): { start: string; end: string } {
  if (period === "day") return { start: d, end: addDays(d, 1) };
  if (period === "week") {
    const start = addDays(d, -weekday(d));
    return { start, end: addDays(start, 7) };
  }
  if (period === "month") {
    const start = `${d.slice(0, 7)}-01`;
    return { start, end: addMonths(start, 1) };
  }
  const start = `${d.slice(0, 4)}-01-01`;
  return { start, end: `${Number(d.slice(0, 4)) + 1}-01-01` };
}

export function periodLabel(period: Period, start: string, end: string): string {
  const [y, m, day] = start.split("-").map(Number);
  if (period === "day") return `${WEEKDAYS[weekday(start)]}, ${day}. ${MONTHS[m - 1]} ${y}`;
  if (period === "week") {
    const last = addDays(end, -1);
    return `KW ${isoWeek(start)} · ${pad(day)}.${pad(m)}. – ${last.slice(8, 10)}.${last.slice(5, 7)}.${last.slice(0, 4)}`;
  }
  if (period === "month") return `${MONTHS[m - 1]} ${y}`;
  return String(y);
}

/** Move by one period. */
export function step(period: Period, d: string, sign: 1 | -1): string {
  if (period === "day") return addDays(d, sign);
  if (period === "week") return addDays(d, 7 * sign);
  if (period === "month") return addMonths(d, sign);
  return addMonths(d, 12 * sign);
}

/** Days (or month starts in the year view) of a period, for the bar chart axis. */
export function periodBuckets(period: Period, start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d < end; d = period === "year" ? addMonths(d, 1) : addDays(d, 1)) out.push(d);
  return out;
}

export function formatDateCh(d: string): string {
  return `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
}
