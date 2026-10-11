import { describe, expect, it } from "vitest";
import { addMonths, isoWeek, periodLabel, periodRange, step, weekday } from "../src/ui/dates";
import { fmt } from "../src/ui/format";

describe("calendar helpers", () => {
  it("computes ISO weeks, including year boundaries", () => {
    expect(isoWeek("2026-10-05")).toBe(41);
    expect(isoWeek("2026-01-01")).toBe(1); // Thursday
    expect(isoWeek("2027-01-01")).toBe(53); // Friday, belongs to week 53 of 2026
    expect(isoWeek("2024-12-30")).toBe(1); // Monday of week 1 of 2025
  });

  it("finds period ranges", () => {
    expect(periodRange("week", "2026-10-09")).toEqual({ start: "2026-10-05", end: "2026-10-12" });
    expect(periodRange("month", "2024-02-15")).toEqual({ start: "2024-02-01", end: "2024-03-01" });
    expect(periodRange("year", "2025-06-30")).toEqual({ start: "2025-01-01", end: "2026-01-01" });
    expect(weekday("2026-10-11")).toBe(6); // Sunday
  });

  it("steps by calendar months and years (end of month clamps)", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(step("year", "2024-02-29", 1)).toBe("2025-02-28");
    expect(step("day", "2026-03-31", 1)).toBe("2026-04-01");
  });

  it("labels periods in German", () => {
    expect(periodLabel("day", "2026-10-09", "2026-10-10")).toBe("Freitag, 9. Oktober 2026");
    expect(periodLabel("week", "2026-10-05", "2026-10-12")).toBe("KW 41 · 05.10. – 11.10.2026");
  });
});

describe("number format", () => {
  it("uses ' as thousands separator", () => {
    expect(fmt(1234567.891, 2)).toBe("1'234'567.89");
    expect(fmt(-1500)).toBe("-1'500");
    expect(fmt(999.5)).toBe("1'000");
  });
});
