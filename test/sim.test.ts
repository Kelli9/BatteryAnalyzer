import { describe, expect, it } from "vitest";
import { type Row, datasetFromRows } from "../src/core/data";
import { type PowerStep, batteryParams, powerStep, simulate } from "../src/core/sim";
import { isPowerSteps } from "../src/ui/power-editor";

const step = (fromKwh: number, chargeKw: number, dischargeKw: number): PowerStep => ({ fromKwh, chargeKw, dischargeKw });
const POWER = [step(0, 5, 4), step(15, 10, 8)];

/** 15-minute rows from local midnight (summer time). */
function rows(values: Row["values"][]): Row[] {
  return values.map((v, i) => {
    const local = `2026-06-15T${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`;
    return { time: Date.parse(`${local}:00+02:00`), local, values: v };
  });
}

describe("power steps", () => {
  const from = (kwh: number, power: PowerStep[] = POWER) => powerStep(batteryParams(kwh, { power })).fromKwh;

  it("takes the step with the highest start at or below the total size", () => {
    expect([from(0), from(14.9), from(15), from(40), from(60)]).toEqual([0, 0, 15, 15, 15]);
    expect(from(12, [step(20, 10, 10), step(5, 5, 5)])).toBe(5); // the order of the list does not matter
  });

  it("uses the lowest step below all starts and the last of steps with the same start", () => {
    expect(from(3, [step(5, 5, 5), step(20, 10, 10)])).toBe(5);
    expect(powerStep(batteryParams(20, { power: [step(0, 5, 5), step(15, 8, 8), step(15, 10, 10)] })).chargeKw).toBe(10);
  });

  it("defaults to 5 kW from 0 kWh and 10 kW from 15 kWh", () => {
    expect([14, 15].map((kwh) => powerStep(batteryParams(kwh))).map((s) => [s.chargeKw, s.dischargeKw]))
      .toEqual([[5, 5], [10, 10]]);
  });

  it("limits the add-on's charge and discharge separately, less what the real battery uses", () => {
    const ds = datasetFromRows(rows([
      // Real battery full and charging 1 kW, 14 kW export
      { consumption: 0, production: 15000, battCharge: 1000, battDischarge: 0, soc: 100 },
      // Real battery empty and discharging 1 kW, 11 kW import
      { consumption: 12000, production: 0, battCharge: 0, battDischarge: 1000, soc: 0 },
    ]));
    const sim = (kwh: number) => simulate(ds, batteryParams(kwh, { realKwh: 10, power: POWER, efficiency: 1 }));
    const below = sim(14), from15 = sim(15);
    expect([below.extraCharge[0], below.extraDischarge[1]]).toEqual([4000, 3000]); // 5 / 4 kW less 1 kW
    expect([from15.extraCharge[0], from15.extraDischarge[1]]).toEqual([9000, 7000]); // 10 / 8 kW less 1 kW
  });

  it("accepts stored steps only as a list of non-negative numbers", () => {
    expect(isPowerSteps(POWER)).toBe(true);
    expect(isPowerSteps([])).toBe(false);
    expect(isPowerSteps({ 15: { chargeKw: 5 } })).toBe(false); // per-size table of an earlier version
    expect(isPowerSteps([{ fromKwh: 0, chargeKw: -1, dischargeKw: 5 }])).toBe(false);
  });
});
