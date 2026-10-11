/**
 * Supported file format: Solar Manager export (a CSV, or the ZIP containing it).
 *
 * A "Date" column with local ISO timestamps and one column per value. Totals have plain headers; device
 * headers span three lines: category, "<device> - <metric>", IP (e.g. "Battery \n<device> - SOC \n<ip>").
 * Devices are matched by category and metric only; the first matching device counts.
 */
import type { Column, Format, Row } from "../data";

const TOTALS: Record<string, Column> = {
  "Consumption": "consumption",
  "Production": "production",
  "Battery Charging": "battCharge",
  "Battery Discharging": "battDischarge",
};
const DEVICES: [category: string, metric: string, Column][] = [
  ["Battery", "SOC", "soc"],
  ["Smart Meter", "currentPower", "gridMeter"],
];

function columnName(header: string): Column | null {
  const lines = header.split("\n").map((l) => l.trim());
  if (lines.length === 1) return TOTALS[lines[0]] ?? null;
  const metric = lines[1].slice(lines[1].lastIndexOf(" - ") + 3);
  for (const [category, m, name] of DEVICES) {
    if (lines[0] === category && metric === m) return name;
  }
  return null;
}

function toNumber(s: string): number {
  return s.trim() === "" ? NaN : Number(s);
}

export const solarManager: Format = {
  label: "Solar-Manager-Export (CSV oder ZIP)",
  matches: (header) => header.includes("Date") && header.some((h) => columnName(h) !== null),
  parse(table) {
    const header = table[0];
    const dateCol = header.indexOf("Date");
    const cols: [number, Column][] = [];
    const seen = new Set<Column>();
    header.forEach((h, i) => {
      if (i === dateCol) return;
      const name = columnName(h);
      if (name && !seen.has(name)) {
        seen.add(name);
        cols.push([i, name]);
      }
    });
    const rows: Row[] = [];
    for (let r = 1; r < table.length; r++) {
      const cells = table[r];
      const stamp = cells[dateCol];
      if (!stamp) continue;
      const values: Row["values"] = {};
      for (const [i, name] of cols) values[name] = toNumber(cells[i] ?? "");
      rows.push({ time: Date.parse(stamp), local: stamp.slice(0, 16), values });
    }
    return rows;
  },
};
