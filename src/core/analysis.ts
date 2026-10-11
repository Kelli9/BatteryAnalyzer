/**
 * Energy flows (actual vs. scenario battery), their value in CHF and period aggregation.
 *
 * The scenario is the measured data plus the simulated difference of a larger or smaller battery
 * (see sim.ts).
 */
import { type Dataset, INTERVAL_H, socFilled } from "./data";
import { type BatteryParams, type SimResult, batteryParams, simulate, socEnergyPerDay } from "./sim";
import { type Schedule, DEFAULT_SCHEDULE, fees, prices } from "./tariff";

export const FLOW_KEYS = [
  "production", "consumption", "pv_direct", "pv_to_batt", "export", "batt_to_load", "grid_to_load",
  "grid_import", "extra_stored", "extra_discharged", "extra_grid_charge", "cost_import", "rev_export",
  "fixed_fee", "saved_import", "lost_export", "batt_saved", "batt_lost",
] as const;
export type FlowKey = (typeof FLOW_KEYS)[number];
/** Per-interval energy flows in kWh and their value in CHF. */
export type Flows = Record<FlowKey, Float64Array>;

const TO_KWH = INTERVAL_H / 1000;

export function flows(ds: Dataset, scen: BatteryParams, tariffs: Schedule = DEFAULT_SCHEDULE,
  sim: SimResult = simulate(ds, scen)): Flows {
  const n = ds.n;
  const s = sim;
  const { imp: pImp, exp: pExp } = prices(ds, tariffs);
  const fee = fees(ds, tariffs, INTERVAL_H);
  const out = Object.fromEntries(FLOW_KEYS.map((k) => [k, new Float64Array(n)])) as Flows;
  for (let i = 0; i < n; i++) {
    const exp = Math.max(-ds.grid[i], 0), imp = Math.max(ds.grid[i], 0);
    const pvToBatt = Math.min(ds.battCharge[i], ds.production[i]);
    const gridToBatt = ds.battCharge[i] - pvToBatt;
    out.production[i] = ds.production[i] * TO_KWH;
    out.consumption[i] = ds.consumption[i] * TO_KWH;
    out.pv_direct[i] = Math.max(ds.production[i] - exp - pvToBatt, 0) * TO_KWH;
    out.pv_to_batt[i] = pvToBatt * TO_KWH;
    out.export[i] = exp * TO_KWH;
    out.batt_to_load[i] = ds.battDischarge[i] * TO_KWH;
    out.grid_to_load[i] = Math.max(imp - gridToBatt, 0) * TO_KWH;
    out.grid_import[i] = imp * TO_KWH; // everything the meter bills: house import plus grid charging
    // Larger battery: export the add-on would have absorbed / house import it would have replaced.
    // Smaller battery: negative, i.e. extra export / extra house import.
    out.extra_stored[i] = s.extraCharge[i] * TO_KWH;
    out.extra_discharged[i] = s.extraDischarge[i] * TO_KWH;
    out.extra_grid_charge[i] = s.extraGridCharge[i] * TO_KWH; // smaller battery: skipped grid charging
    out.cost_import[i] = out.grid_import[i] * pImp[i];
    out.rev_export[i] = out.export[i] * pExp[i];
    out.fixed_fee[i] = fee[i];
    // Scenario vs. real battery: import cost avoided, feed-in revenue given up (negative when smaller)
    out.saved_import[i] = (Math.min(out.extra_discharged[i], out.grid_to_load[i]) - out.extra_grid_charge[i]) * pImp[i];
    out.lost_export[i] = out.extra_stored[i] * pExp[i];
    // Same for the real battery; grid charging costs the import price at the time of charging
    out.batt_saved[i] = out.batt_to_load[i] * pImp[i];
    out.batt_lost[i] = out.pv_to_batt[i] * pExp[i] + (out.grid_import[i] - out.grid_to_load[i]) * pImp[i];
  }
  return out;
}

export const AGG_KEYS = [
  ...FLOW_KEYS, "export_scen", "grid_scen", "saving", "batt_saving", "cost_import_scen", "rev_export_scen",
  "net_cost", "net_cost_scen",
] as const;
export type AggKey = (typeof AGG_KEYS)[number];
export type AggRow = Record<AggKey, number> & { key: number };

/** Grouping: one row, per local day (yyyymmdd), month (yyyymm), hour or interval (both epoch ms). */
export type GroupBy = "none" | "day" | "month" | "hour" | "interval";

/** Index range [from, to) of the intervals whose local day lies in [startDay, endDay) (yyyymmdd). */
export function dayRange(ds: Dataset, startDay: number, endDay: number): [number, number] {
  return [lowerBound(ds.dayKey, startDay), lowerBound(ds.dayKey, endDay)];
}

/** Index range [from, to) of the intervals starting in [startMs, endMs). */
export function timeRange(ds: Dataset, startMs: number, endMs: number): [number, number] {
  return [lowerBound(ds.time, startMs), lowerBound(ds.time, endMs)];
}

function lowerBound(sorted: ArrayLike<number>, value: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Derived columns of a summed row (the add-on can only replace import that happened). */
export function derive(row: AggRow): AggRow {
  row.extra_discharged = Math.min(row.extra_discharged, row.grid_to_load);
  row.export_scen = row.export - row.extra_stored;
  row.grid_scen = row.grid_to_load - row.extra_discharged;
  row.saving = row.saved_import - row.lost_export;
  row.batt_saving = row.batt_saved - row.batt_lost;
  row.cost_import_scen = row.cost_import - row.saved_import;
  row.rev_export_scen = row.rev_export - row.lost_export;
  row.net_cost = row.cost_import - row.rev_export + row.fixed_fee;
  row.net_cost_scen = row.net_cost - row.saving;
  return row;
}

function emptyRow(key: number): AggRow {
  const row = { key } as AggRow;
  for (const k of AGG_KEYS) row[k] = 0;
  return row;
}

function groupKey(ds: Dataset, i: number, by: GroupBy): number {
  switch (by) {
    case "none": return 0;
    case "day": return ds.dayKey[i];
    case "month": return ds.monthKey[i];
    case "hour": return ds.time[i] - (ds.time[i] % 3_600_000);
    case "interval": return ds.time[i];
  }
}

/** Raw sums of the flows over the intervals [from, to), grouped; rows only for keys with data. */
export function sumFlows(ds: Dataset, fl: Flows, [from, to]: [number, number], by: GroupBy): AggRow[] {
  const rows = new Map<number, AggRow>();
  for (let i = from; i < to; i++) {
    const key = groupKey(ds, i, by);
    let row = rows.get(key);
    if (!row) rows.set(key, (row = emptyRow(key)));
    for (const k of FLOW_KEYS) row[k] += fl[k][i];
  }
  if (by === "none" && rows.size === 0) rows.set(0, emptyRow(0));
  return [...rows.values()].sort((a, b) => a.key - b.key);
}

/** Sum flows over the intervals [from, to), grouped, with derived columns. */
export function aggregate(ds: Dataset, fl: Flows, range: [number, number], by: GroupBy): AggRow[] {
  return sumFlows(ds, fl, range, by).map(derive);
}

export function emptyAggRow(key = 0): AggRow {
  return emptyRow(key);
}

/** (actual, scenario) pairs for the headline tiles. */
export function kpis(total: AggRow): Record<string, [number, number]> {
  const prod = total.production, cons = total.consumption;
  const pct = (num: number, den: number) => (den ? (100 * num) / den : 0);
  return {
    production: [prod, prod],
    consumption: [cons, cons],
    grid: [total.grid_to_load, total.grid_scen],
    export: [total.export, total.export_scen],
    autarky: [pct(cons - total.grid_to_load, cons), pct(cons - total.grid_scen, cons)],
    self_use: [pct(prod - total.export, prod), pct(prod - total.export_scen, prod)],
    cost_import: [total.cost_import, total.cost_import_scen],
    rev_export: [total.rev_export, total.rev_export_scen],
    net_cost: [total.net_cost, total.net_cost_scen],
  };
}

export interface SizePoint {
  capacity: number;
  avoided: number;
  saving: number;
  autarky: number;
}

/** Avoided grid import, cost saving and autarky in [start, end) for each battery size. */
export function sizeCurve(ds: Dataset, range: [number, number], sizes: number[],
  tariffs: Schedule = DEFAULT_SCHEDULE, model: Partial<BatteryParams> = {}): SizePoint[] {
  return sizes.map((c) => {
    const t = aggregate(ds, flows(ds, batteryParams(c, model), tariffs), range, "none")[0];
    return { capacity: c, avoided: t.extra_discharged, saving: t.saving, autarky: kpis(t).autarky[1] };
  });
}

const DAY_MS = 86_400_000;

/** Local midnight (epoch ms) of each day key, from the day's first interval. */
function dayStarts(ds: Dataset): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < ds.n; i++) {
    if (out.has(ds.dayKey[i])) continue;
    const d = new Date(ds.time[i]);
    // Minutes past local midnight = local hour * 60 + minute (minutes are equal in UTC and local here)
    out.set(ds.dayKey[i], ds.time[i] - (ds.hour[i] * 60 + d.getUTCMinutes()) * 60_000);
  }
  return out;
}

/** Sums of `values` over a time window (t - windowMs, t] ending at each row (rows sorted by t). */
function rollingSums(times: number[], values: number[][], windowMs: number): number[][] {
  const out: number[][] = [];
  let lo = 0;
  for (let j = 0; j < times.length; j++) {
    while (times[lo] <= times[j] - windowMs) lo++;
    out.push(values[0].map((_, c) => {
      let s = 0;
      for (let k = lo; k <= j; k++) s += values[k][c];
      return s;
    }));
  }
  return out;
}

export interface EfficiencyDay {
  time: number; // local midnight, epoch ms
  dayKey: number;
  charge: number; // kWh SOC rise per kWh AC charged
  discharge: number; // kWh AC delivered per kWh SOC drop
  roundTrip: number;
  throughput: number; // kWh SOC drop
  chargeAvg: number; // energy-weighted rolling averages
  dischargeAvg: number;
  roundTripAvg: number;
}

/** Daily charge / discharge / round-trip efficiency of the real battery, measured against its SOC.
 * Days with less than minKwh SOC change or AC flow either way are left out (noise, gaps). */
export function batteryEfficiency(ds: Dataset, realKwh: number, minKwh = 2, windowDays = 30): EfficiencyDay[] {
  const starts = dayStarts(ds);
  const days = socEnergyPerDay(ds, realKwh).filter((d) => d.eUp >= minKwh && d.eDown >= minKwh && d.acUp >= minKwh
    && d.acDown >= minKwh);
  const times = days.map((d) => starts.get(d.dayKey)!);
  const roll = rollingSums(times, days.map((d) => [d.eUp, d.acUp, d.acDown, d.eDown]), windowDays * DAY_MS);
  return days.map((d, i) => {
    const [eUp, acUp, acDown, eDown] = roll[i];
    const charge = d.eUp / d.acUp, discharge = d.acDown / d.eDown;
    const chargeAvg = eUp / acUp, dischargeAvg = acDown / eDown;
    return {
      time: times[i], dayKey: d.dayKey, charge, discharge, roundTrip: charge * discharge, throughput: d.eDown,
      chargeAvg, dischargeAvg, roundTripAvg: chargeAvg * dischargeAvg,
    };
  });
}

export interface FullCycle {
  start: number; // epoch ms
  kind: "charge" | "discharge";
  kwhPerCycle: number;
  hours: number;
  avg: number; // rolling median per kind
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** AC energy of the real battery's full charges (SOC <= empty -> >= full) and discharges (back),
 * scaled to 0 -> 100 %: a direct measure of its usable capacity, independent of the SOC scale.
 * Only clean cycles count: the SOC moves one way (3 % tolerance), within the max hours, with at
 * most maxOtherKwh flowing the other way. avg: rolling median per direction over windowDays. */
export function fullCycles(ds: Dataset, empty = 5, full = 99, maxChargeH = 12, maxDischargeH = 24,
  maxOtherKwh = 0.2, windowDays = 60): FullCycle[] {
  const soc = socFilled(ds);
  const n = ds.n;
  const c = ds.battCharge.map((v) => v * TO_KWH), d = ds.battDischarge.map((v) => v * TO_KWH);
  const sum = (a: Float64Array, from: number, to: number) => {
    let s = 0;
    for (let k = from; k < to; k++) s += a[k];
    return s;
  };
  const cycles: FullCycle[] = [];
  let i = 0;
  while (i < n) {
    const charging = soc[i] <= empty;
    if (charging || soc[i] >= full) {
      let j = i;
      while (j < n && (charging ? soc[i] - 3 <= soc[j] && soc[j] < full : empty < soc[j] && soc[j] <= soc[i] + 3)) j++;
      if (j < n && (charging ? soc[j] >= full : soc[j] <= empty)) { // reached the other end
        const [ac, other] = charging ? [c, d] : [d, c];
        const hours = (j - i) * INTERVAL_H;
        if (hours <= (charging ? maxChargeH : maxDischargeH) && sum(other, i + 1, j + 1) <= maxOtherKwh) {
          cycles.push({ start: ds.time[i], kind: charging ? "charge" : "discharge",
            kwhPerCycle: (sum(ac, i + 1, j + 1) / Math.abs(soc[j] - soc[i])) * 100, hours, avg: NaN });
        }
        i = j;
        continue;
      }
    }
    i++;
  }
  for (const kind of ["charge", "discharge"] as const) {
    const sel = cycles.filter((x) => x.kind === kind);
    let lo = 0;
    sel.forEach((x, j) => {
      while (sel[lo].start <= x.start - windowDays * DAY_MS) lo++;
      x.avg = median(sel.slice(lo, j + 1).map((y) => y.kwhPerCycle));
    });
  }
  return cycles;
}
