/**
 * Battery size simulation on 15-minute measurements.
 *
 * Larger: the extra capacity is modelled as an add-on to the real one: it only charges from PV
 * export while the real battery is full, and only covers house grid import while the real battery
 * is empty. A wallbox counts as normal consumption.
 *
 * Smaller (down to none): the smaller battery follows the real battery's measured content (SOC)
 * and only differs by a gap g = real - small content. The gap grows when the small battery is full
 * while the real one still charges, and shrinks when it is empty while the real one still
 * discharges: g = clip(g, real - C, real). Charge it cannot store is exported (or, if it came from
 * the grid, not imported); discharge it cannot deliver is imported. Content is converted to AC
 * with factors measured per day (kWh AC per kWh SOC change while rising / falling), which absorb
 * SOC recalibration jumps and keep every whole day exact at 0 kWh. Flows in intervals where the
 * SOC does not move that way (top-up charging while full, standby draw, 1 % SOC steps) are missed
 * in proportion to the missing capacity. Exact at 0 kWh and at the real capacity, cannot drift.
 *
 * Add-on losses: charging is taken as (nearly) lossless against the SOC and the round-trip loss is
 * applied on discharge (the battery tab measures both for the real battery).
 *
 * Add-on power: the real and the add-on battery together charge and discharge at most at the power of
 * the power step of the total size.
 */
import { type Dataset, INTERVAL_H, socFilled } from "./data";

/** Nominal capacity of the real battery unless set otherwise. */
export const DEFAULT_REAL_KWH = 10;

/** Max. charge / discharge power (kW) of the whole battery, real plus add-on, from a total size on. */
export interface PowerStep {
  fromKwh: number;
  chargeKw: number;
  dischargeKw: number;
}

/** Each step holds from its total size up to the next step's; the lowest one also below. In any order. */
export type PowerSteps = PowerStep[];

/** Example values: 5 kW from 0 kWh, 10 kW from 15 kWh in total. */
export const DEFAULT_POWER: PowerSteps = [
  { fromKwh: 0, chargeKw: 5, dischargeKw: 5 },
  { fromKwh: 15, chargeKw: 10, dischargeKw: 10 },
];

export interface BatteryParams {
  capacityKwh: number; // total size incl. the real battery
  realKwh: number; // nominal capacity of the real battery
  efficiency: number; // round trip (AC to AC)
  chargeEfficiency: number; // share of it on charge (~1.0); the rest is lost on discharge
  socMin: number; // % of the add-on capacity
  socMax: number; // % of the add-on capacity
  power: PowerSteps;
  fullSoc: number; // real battery counts as full at/above this SOC
  emptySoc: number; // real battery counts as empty at/below this SOC
}

export function batteryParams(capacityKwh: number, overrides: Partial<BatteryParams> = {}): BatteryParams {
  return {
    capacityKwh, realKwh: DEFAULT_REAL_KWH, efficiency: 0.81, chargeEfficiency: 1.0, socMin: 0, socMax: 100,
    power: DEFAULT_POWER, fullSoc: 97, emptySoc: 5, ...overrides,
  };
}

/** The power step of the total size: the one with the highest start at or below it (of equal starts the
 * last in the list), else the lowest one. */
export function powerStep(p: BatteryParams): PowerStep {
  const byStart = [...p.power].sort((a, b) => a.fromKwh - b.fromKwh);
  return byStart.filter((s) => s.fromKwh <= p.capacityKwh).pop() ?? byStart[0] ?? DEFAULT_POWER[0];
}

/** Per interval (W): charge / discharge of the add-on (larger) or what the smaller battery misses
 * (negative), grid charging it skips (<= 0), and its content relative to the real battery (Wh). */
export interface SimResult {
  extraCharge: Float64Array;
  extraDischarge: Float64Array;
  extraGridCharge: Float64Array;
  extraEnergy: Float64Array;
}

/** Real battery content from the SOC (Wh). */
export function realContentWh(ds: Dataset, realKwh: number): Float64Array {
  const soc = socFilled(ds);
  const out = new Float64Array(ds.n);
  for (let i = 0; i < ds.n; i++) out[i] = (soc[i] / 100) * realKwh * 1000;
  return out;
}

export interface SocEnergyDay {
  dayKey: number;
  acUp: number; // kWh AC charged while the SOC rises
  eUp: number; // kWh SOC rise
  acDown: number; // kWh AC discharged while the SOC falls
  eDown: number; // kWh SOC drop
}

/** Per day: AC charged while the SOC rises and the rise, AC discharged while it falls and the drop. */
export function socEnergyPerDay(ds: Dataset, realKwh: number): SocEnergyDay[] {
  const real = realContentWh(ds, realKwh);
  const days: SocEnergyDay[] = [];
  let cur: SocEnergyDay | null = null;
  for (let i = 0; i < ds.n; i++) {
    if (!cur || cur.dayKey !== ds.dayKey[i]) {
      cur = { dayKey: ds.dayKey[i], acUp: 0, eUp: 0, acDown: 0, eDown: 0 };
      days.push(cur);
    }
    if (i === 0) continue; // no previous content
    const d = real[i] - real[i - 1];
    if (d > 0) {
      cur.acUp += (ds.battCharge[i] * INTERVAL_H) / 1000;
      cur.eUp += d / 1000;
    } else if (d < 0) {
      cur.acDown += (ds.battDischarge[i] * INTERVAL_H) / 1000;
      cur.eDown += -d / 1000;
    }
  }
  return days;
}

function simulateAddOn(ds: Dataset, p: BatteryParams): SimResult {
  const n = ds.n;
  const capWh = Math.max(p.capacityKwh - p.realKwh, 0) * 1000;
  const soc = socFilled(ds);
  const eMin = (capWh * p.socMin) / 100, eMax = (capWh * p.socMax) / 100;
  const { chargeKw, dischargeKw } = powerStep(p);
  const pCharge = chargeKw * 1000, pDischarge = dischargeKw * 1000;
  const etaC = p.chargeEfficiency, etaD = p.efficiency / p.chargeEfficiency, dt = INTERVAL_H;
  const charge = new Float64Array(n), discharge = new Float64Array(n), energy = new Float64Array(n);
  let e = eMin;
  for (let i = 0; i < n; i++) {
    const g = ds.grid[i];
    const exp = Math.max(-g, 0), imp = Math.max(g, 0);
    if (exp > 0 && soc[i] >= p.fullSoc) {
      const c = Math.min(exp, Math.max(pCharge - ds.battCharge[i], 0), Math.max(eMax - e, 0) / (etaC * dt));
      charge[i] = c;
      e += c * etaC * dt;
    } else if (imp > 0 && soc[i] <= p.emptySoc) {
      const deficit = Math.max(ds.consumption[i] - ds.production[i] - ds.battDischarge[i], 0);
      const d = Math.min(deficit, imp, Math.max(pDischarge - ds.battDischarge[i], 0), (Math.max(e - eMin, 0) * etaD) / dt);
      discharge[i] = d;
      e -= (d / etaD) * dt;
    }
    energy[i] = e;
  }
  return { extraCharge: charge, extraDischarge: discharge, extraGridCharge: new Float64Array(n), extraEnergy: energy };
}

function simulateSmaller(ds: Dataset, p: BatteryParams): SimResult {
  const n = ds.n;
  const real = realContentWh(ds, p.realKwh);
  const cap = p.capacityKwh * 1000;
  // Content gap real - small (Wh): grows while the small battery is full, shrinks while it is empty
  const gap = new Float64Array(n);
  let g = Math.max(real[0] - cap, 0);
  for (let i = 0; i < n; i++) {
    g = Math.min(Math.max(g, real[i] - cap), real[i]);
    gap[i] = g;
  }
  // Per day: kWh AC per kWh content while the SOC rises / falls
  const perDay = new Map(socEnergyPerDay(ds, p.realKwh).map((d) => [d.dayKey, d]));
  const unexplained = 1 - p.capacityKwh / p.realKwh;
  const res: SimResult = {
    extraCharge: new Float64Array(n), extraDischarge: new Float64Array(n),
    extraGridCharge: new Float64Array(n), extraEnergy: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const day = perDay.get(ds.dayKey[i])!;
    const acPerUp = day.eUp > 0 ? day.acUp / day.eUp : 0;
    const acPerDown = day.eDown > 0 ? day.acDown / day.eDown : 0;
    const dReal = i > 0 ? real[i] - real[i - 1] : 0;
    const dGap = i > 0 ? gap[i] - gap[i - 1] : 0;
    const reqC = ds.battCharge[i], reqD = ds.battDischarge[i];
    const missedC = dReal > 0 ? (Math.max(dGap, 0) * acPerUp) / INTERVAL_H : reqC * unexplained;
    const missedD = dReal < 0 ? (-Math.min(dGap, 0) * acPerDown) / INTERVAL_H : reqD * unexplained;
    const pvShare = reqC > 0 ? Math.min(reqC, ds.production[i]) / reqC : 1;
    res.extraCharge[i] = -missedC * pvShare;
    res.extraDischarge[i] = -missedD;
    res.extraGridCharge[i] = -missedC * (1 - pvShare);
    res.extraEnergy[i] = -gap[i];
  }
  return res;
}

export function simulate(ds: Dataset, p: BatteryParams): SimResult {
  return p.capacityKwh < p.realKwh ? simulateSmaller(ds, p) : simulateAddOn(ds, p);
}
