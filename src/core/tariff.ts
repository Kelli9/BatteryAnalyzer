/**
 * Tariff periods: each has high / low tariff energy prices, a monthly fixed fee and the high tariff
 * times for Monday–Friday, Saturday and Sunday (defaults: round example values, to be replaced by the
 * prices of one's own utility).
 *
 * Hochtarif (HT): within the day type's window; public holidays count like any other weekday.
 * Niedertarif (NT): all other times.
 */
import type { Dataset } from "./data";

/** High tariff from `from` to `to`, minutes after local midnight; `to` <= `from` runs past midnight
 * (00:00 as end = until midnight, equal times = the whole day). null: low tariff all day. */
export interface HtWindow {
  from: number;
  to: number;
}

/** Day types of the high tariff times. */
export const DAY_TYPES = ["Mo–Fr", "Sa", "So"] as const;

export interface Tariff {
  importHt: number; // CHF/kWh incl. VAT
  importNt: number;
  exportHt: number; // CHF/kWh feed-in (no VAT for private producers)
  exportNt: number;
  feeMonth: number; // CHF/month incl. VAT, fixed fees (Grundpreis + Messpreis); 0 = leave out
  ht: [weekdays: HtWindow | null, saturday: HtWindow | null, sunday: HtWindow | null];
}

/** A tariff valid from `from` to `to` (local dates "YYYY-MM-DD", both inclusive). */
export interface TariffPeriod extends Tariff {
  from: string;
  to: string;
}

/** Days that lie in no period use the nearest one; where periods overlap, the later starting one applies. */
export type Schedule = TariffPeriod[];

/** Example prices (not those of a particular utility). */
export const DEFAULT_TARIFF: Tariff = {
  importHt: 0.3, importNt: 0.25, exportHt: 0.1, exportNt: 0.1, feeMonth: 10,
  ht: [{ from: 7 * 60, to: 20 * 60 }, { from: 7 * 60, to: 13 * 60 }, null],
};

/** One calendar year with the given tariff. */
export function yearPeriod(year: number, tariff: Tariff): TariffPeriod {
  return { ...tariff, ht: [...tariff.ht], from: `${year}-01-01`, to: `${year}-12-31` };
}

/** The example prices, used for every day. */
export const DEFAULT_SCHEDULE: Schedule = [yearPeriod(2025, DEFAULT_TARIFF)];

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

function dateOf(dayKey: number): string {
  const s = String(dayKey);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** The tariff of a local day ("YYYY-MM-DD"). */
export function tariffOn(schedule: Schedule, date: string): Tariff {
  const day = dayNumber(date);
  let best: TariffPeriod | null = null, bestDist = Infinity;
  for (const p of schedule) {
    if (p.from > p.to) continue; // covers no day
    const dist = date < p.from ? dayNumber(p.from) - day : date > p.to ? day - dayNumber(p.to) : 0;
    if (dist < bestDist || (dist === bestDist && p.from > best!.from)) [best, bestDist] = [p, dist];
  }
  return best ?? DEFAULT_TARIFF;
}

/** weekday: 0 = Monday; minute: minutes after local midnight. */
export function isHighTariff(tariff: Tariff, weekday: number, minute: number): boolean {
  const w = tariff.ht[weekday < 5 ? 0 : weekday === 5 ? 1 : 2];
  if (!w) return false;
  return w.from < w.to ? minute >= w.from && minute < w.to : minute >= w.from || minute < w.to;
}

/** Tariff of each interval (looked up once per day). */
function perInterval(ds: Dataset, schedule: Schedule, fn: (i: number, t: Tariff) => void): void {
  let key = -1, t = DEFAULT_TARIFF;
  for (let i = 0; i < ds.n; i++) {
    if (ds.dayKey[i] !== key) [key, t] = [ds.dayKey[i], tariffOn(schedule, dateOf(ds.dayKey[i]))];
    fn(i, t);
  }
}

/** Import and export price per interval in CHF/kWh. */
export function prices(ds: Dataset, schedule: Schedule): { imp: Float64Array; exp: Float64Array } {
  const imp = new Float64Array(ds.n), exp = new Float64Array(ds.n);
  perInterval(ds, schedule, (i, t) => {
    // Offsets are whole hours, so the minutes are the same in UTC and local time
    const ht = isHighTariff(t, ds.weekday[i], ds.hour[i] * 60 + (Math.floor(ds.time[i] / 60_000) % 60));
    imp[i] = ht ? t.importHt : t.importNt;
    exp[i] = ht ? t.exportHt : t.exportNt;
  });
  return { imp, exp };
}

/** Monthly fixed fee spread evenly over the month's intervals (CHF per interval). */
export function fees(ds: Dataset, schedule: Schedule, intervalH: number): Float64Array {
  const out = new Float64Array(ds.n);
  perInterval(ds, schedule, (i, t) => (out[i] = (t.feeMonth * intervalH) / (24 * ds.daysInMonth[i])));
  return out;
}

const shift = (date: string, days: number) => new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);

/** The periods that cover at least one day, sorted by start. */
function byStart(schedule: Schedule): Schedule {
  return schedule.filter((p) => p.from <= p.to).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/** Days that several periods cover, as [from, to] date ranges. */
export function overlaps(schedule: Schedule): [string, string][] {
  const out: [string, string][] = [];
  let end = ""; // last day covered by an earlier starting period
  for (const p of byStart(schedule)) {
    if (end && p.from <= end) {
      const to = p.to < end ? p.to : end, prev = out[out.length - 1];
      if (prev && p.from <= shift(prev[1], 1)) prev[1] = to > prev[1] ? to : prev[1];
      else out.push([p.from, to]);
    }
    if (p.to > end) end = p.to;
  }
  return out;
}

/** Days in [first, last] that no period covers, as [from, to] date ranges. */
export function gaps(schedule: Schedule, first: string, last: string): [string, string][] {
  const out: [string, string][] = [];
  let next = first; // first day not covered by an earlier starting period
  for (const p of byStart(schedule)) {
    if (next > last) break;
    if (p.from > next) out.push([next, p.from <= last ? shift(p.from, -1) : last]);
    if (shift(p.to, 1) > next) next = shift(p.to, 1);
  }
  if (next <= last) out.push([next, last]);
  return out;
}
