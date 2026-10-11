/**
 * Load measurement files (CSV, or ZIP archives containing CSVs) into one columnar dataset, entirely in
 * memory. Each supported file format (src/core/formats/) turns a CSV table into rows of 15-minute values;
 * everything else here is independent of the format.
 *
 * All power columns are average watts over the 15-minute interval. Timestamps carry their local
 * offset, so local calendar fields are read straight from the text.
 */
import JSZip from "jszip";
import { parseCsv } from "./csv";
import { FORMATS } from "./formats";

export const INTERVAL_H = 0.25;

export type Column = "consumption" | "production" | "battCharge" | "battDischarge" | "soc" | "gridMeter";
const COLUMNS: Column[] = ["consumption", "production", "battCharge", "battDischarge", "soc", "gridMeter"];
// Flows that are missing or negative count as 0; soc and the grid meter keep gaps (NaN).
const ZERO_FILLED: Column[] = ["consumption", "production", "battCharge", "battDischarge"];

export interface Dataset {
  n: number;
  /** Interval start, epoch ms. */
  time: Float64Array;
  /** Local calendar fields of the interval start. */
  year: Int16Array;
  month: Int8Array; // 1-12
  day: Int8Array;
  hour: Int8Array;
  weekday: Int8Array; // 0 = Monday
  daysInMonth: Int8Array;
  dayKey: Int32Array; // yyyymmdd
  monthKey: Int32Array; // yyyymm
  consumption: Float64Array;
  production: Float64Array;
  battCharge: Float64Array;
  battDischarge: Float64Array;
  soc: Float64Array;
  gridMeter: Float64Array;
  /** Grid flow from the energy balance: + import, - export (W). */
  grid: Float64Array;
}

/** One 15-minute interval as read from a file. */
export interface Row {
  time: number; // interval start, epoch ms
  local: string; // local start, "YYYY-MM-DDTHH:MM"
  values: Partial<Record<Column, number>>;
}

/** A supported file format: recognises its CSV tables and turns them into rows. */
export interface Format {
  /** Name shown to the user ("Derzeit unterstützt: …"). */
  label: string;
  /** Whether a header row belongs to this format. */
  matches(header: string[]): boolean;
  /** Rows of a table in this format (the first row is the header). */
  parse(table: string[][]): Row[];
}

/** The supported formats as one line for the user. */
export function supportedFormats(): string {
  return FORMATS.map((f) => f.label).join(", ");
}

/** Rows of one CSV text in whichever supported format it is. */
function parseFile(text: string): Row[] {
  const table = parseCsv(text);
  const format = FORMATS.find((fmt) => fmt.matches(table[0] ?? []));
  if (!format) throw new Error(`Format nicht erkannt. Derzeit unterstützt: ${supportedFormats()}.`);
  return format.parse(table);
}

export interface ExportFile {
  name: string;
  data: ArrayBuffer | Uint8Array;
}

/** Text of every CSV inside the given ZIP / CSV files, files in name order. */
export async function exportTexts(files: ExportFile[]): Promise<string[]> {
  const texts: string[] = [];
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".csv")) {
      texts.push(new TextDecoder().decode(f.data));
    } else if (lower.endsWith(".zip")) {
      const zip = await JSZip.loadAsync(f.data);
      for (const entry of Object.values(zip.files)) {
        if (!entry.dir && entry.name.toLowerCase().endsWith(".csv")) texts.push(await entry.async("string"));
      }
    }
  }
  return texts;
}

/** Merge files (later files win on equal timestamps), sort by time and build the dataset. */
export function buildDataset(texts: string[]): Dataset {
  const byTime = new Map<number, Row>();
  for (const text of texts) for (const row of parseFile(text)) byTime.set(row.time, row);
  return datasetFromRows([...byTime.values()].sort((x, y) => x.time - y.time));
}

/** Columnar dataset from rows sorted by time, with the calendar fields and the grid flow. */
export function datasetFromRows(rows: Row[]): Dataset {
  const n = rows.length;
  if (n === 0) throw new Error("Keine Daten in den gewählten Dateien gefunden.");

  const ds = {
    n,
    time: new Float64Array(n),
    year: new Int16Array(n),
    month: new Int8Array(n),
    day: new Int8Array(n),
    hour: new Int8Array(n),
    weekday: new Int8Array(n),
    daysInMonth: new Int8Array(n),
    dayKey: new Int32Array(n),
    monthKey: new Int32Array(n),
    grid: new Float64Array(n),
  } as Dataset;
  for (const c of COLUMNS) ds[c] = new Float64Array(n);

  rows.forEach((row, i) => {
    const y = Number(row.local.slice(0, 4));
    const m = Number(row.local.slice(5, 7));
    const d = Number(row.local.slice(8, 10));
    ds.time[i] = row.time;
    ds.year[i] = y;
    ds.month[i] = m;
    ds.day[i] = d;
    ds.hour[i] = Number(row.local.slice(11, 13));
    ds.weekday[i] = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    ds.daysInMonth[i] = new Date(Date.UTC(y, m, 0)).getUTCDate();
    ds.dayKey[i] = y * 10000 + m * 100 + d;
    ds.monthKey[i] = y * 100 + m;
    for (const c of COLUMNS) {
      const v = row.values[c] ?? NaN;
      ds[c][i] = ZERO_FILLED.includes(c) ? (Number.isNaN(v) ? 0 : Math.max(v, 0)) : v;
    }
    // Grid flow from the energy balance (the smart meter column can be missing): + import, - export
    ds.grid[i] = ds.consumption[i] - ds.production[i] + ds.battCharge[i] - ds.battDischarge[i];
  });
  return ds;
}

export async function loadExports(files: ExportFile[]): Promise<Dataset> {
  return buildDataset(await exportTexts(files));
}

/** SOC with gaps filled forward (0 before the first value), as the simulation uses it. */
export function socFilled(ds: Dataset): Float64Array {
  const out = new Float64Array(ds.n);
  let last = 0;
  for (let i = 0; i < ds.n; i++) {
    if (!Number.isNaN(ds.soc[i])) last = ds.soc[i];
    out[i] = last;
  }
  return out;
}
