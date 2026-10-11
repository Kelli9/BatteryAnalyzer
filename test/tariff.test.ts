import { describe, expect, it } from "vitest";
import { datasetFromRows } from "../src/core/data";
import {
  DEFAULT_TARIFF, type Tariff, type TariffPeriod, fees, gaps, isHighTariff, overlaps, prices, tariffOn,
} from "../src/core/tariff";

const period = (from: string, to: string, importHt = 0.3): TariffPeriod => ({ ...DEFAULT_TARIFF, importHt, from, to });
const at = (h: number, m = 0) => h * 60 + m;

describe("tariff periods", () => {
  const schedule = [period("2025-01-01", "2025-12-31", 0.3), period("2026-04-01", "2026-12-31", 0.4)];

  it("picks the period of a day, else the nearest one", () => {
    expect(tariffOn(schedule, "2025-06-30").importHt).toBe(0.3);
    expect(tariffOn(schedule, "2026-04-01").importHt).toBe(0.4);
    expect(tariffOn(schedule, "2024-03-01").importHt).toBe(0.3); // before all periods
    expect(tariffOn(schedule, "2026-01-20").importHt).toBe(0.3); // gap: 20 days after vs. 71 days before
    expect(tariffOn(schedule, "2026-03-20").importHt).toBe(0.4);
    expect(tariffOn(schedule, "2030-01-01").importHt).toBe(0.4); // after all periods
  });

  it("lets the later starting period win where periods overlap", () => {
    const s = [period("2025-01-01", "2025-12-31", 0.3), period("2025-07-01", "2025-07-31", 0.5)];
    expect(tariffOn(s, "2025-07-15").importHt).toBe(0.5);
    expect(tariffOn(s, "2025-08-01").importHt).toBe(0.3);
    expect(overlaps(s)).toEqual([["2025-07-01", "2025-07-31"]]);
  });

  it("ignores periods that end before they start", () => {
    expect(tariffOn([period("2025-02-01", "2025-01-01", 0.5), period("2026-01-01", "2026-12-31")], "2025-01-15").importHt)
      .toBe(0.3);
    expect(tariffOn([period("2025-02-01", "2025-01-01")], "2025-01-15")).toBe(DEFAULT_TARIFF);
  });

  it("finds days without a period and with several", () => {
    expect(gaps(schedule, "2024-12-01", "2026-06-30")).toEqual([
      ["2024-12-01", "2024-12-31"], ["2026-01-01", "2026-03-31"],
    ]);
    expect(gaps(schedule, "2025-02-01", "2025-03-01")).toEqual([]);
    expect(gaps(schedule, "2027-01-01", "2027-01-05")).toEqual([["2027-01-01", "2027-01-05"]]);
    expect(overlaps(schedule)).toEqual([]);
    const three = [period("2025-01-01", "2025-06-30"), period("2025-06-01", "2025-12-31"), period("2025-09-01", "2025-09-10")];
    expect(overlaps(three)).toEqual([["2025-06-01", "2025-06-30"], ["2025-09-01", "2025-09-10"]]);
    // Consecutive days form one run
    expect(overlaps([...three, period("2025-06-25", "2025-07-05")])).toEqual([["2025-06-01", "2025-07-05"],
      ["2025-09-01", "2025-09-10"]]);
  });
});

describe("high tariff times", () => {
  it("uses the window of the day type", () => {
    const t = DEFAULT_TARIFF; // Mo–Fr 07–20, Sa 07–13, So none
    expect(isHighTariff(t, 0, at(6, 45))).toBe(false);
    expect(isHighTariff(t, 0, at(7))).toBe(true);
    expect(isHighTariff(t, 4, at(19, 45))).toBe(true);
    expect(isHighTariff(t, 4, at(20))).toBe(false);
    expect(isHighTariff(t, 5, at(12, 45))).toBe(true);
    expect(isHighTariff(t, 5, at(13))).toBe(false);
    expect(isHighTariff(t, 6, at(12))).toBe(false);
  });

  it("runs past midnight when the end is not after the start", () => {
    const t: Tariff = { ...DEFAULT_TARIFF, ht: [{ from: at(20), to: 0 }, { from: at(22), to: at(6) }, { from: at(7), to: at(7) }] };
    expect(isHighTariff(t, 0, at(23, 45))).toBe(true); // 20:00–00:00 = until midnight
    expect(isHighTariff(t, 0, at(0))).toBe(false);
    expect(isHighTariff(t, 5, at(5, 45))).toBe(true);
    expect(isHighTariff(t, 5, at(12))).toBe(false);
    expect(isHighTariff(t, 6, at(3))).toBe(true); // equal times: the whole day
  });
});

describe("prices per interval", () => {
  // Wednesday 2025-12-31, Saturday 2026-01-03 and Sunday 2026-01-04 (winter time, +01:00)
  const local = ["2025-12-31T07:00", "2025-12-31T19:45", "2025-12-31T20:00", "2026-01-03T12:45", "2026-01-03T13:00",
    "2026-01-04T12:00"];
  const ds = datasetFromRows(local.map((l) => ({ time: Date.parse(`${l}:00+01:00`), local: l, values: {} })));
  const schedule = [
    { ...period("2025-01-01", "2025-12-31", 0.3), importNt: 0.2, exportHt: 0.12, feeMonth: 31 },
    { ...period("2026-01-01", "2026-12-31", 0.4), importNt: 0.35, feeMonth: 62 },
  ];

  it("uses each day's period and the high tariff times of its day type", () => {
    const { imp, exp } = prices(ds, schedule);
    expect([...imp]).toEqual([0.3, 0.3, 0.2, 0.4, 0.35, 0.35]);
    expect([...exp]).toEqual([0.12, 0.12, 0.1, 0.1, 0.1, 0.1]);
  });

  it("spreads each period's fee over its month", () => {
    const f = fees(ds, schedule, 0.25);
    expect(f[0]).toBeCloseTo((31 * 0.25) / (24 * 31), 12);
    expect(f[3]).toBeCloseTo((62 * 0.25) / (24 * 31), 12);
  });
});
