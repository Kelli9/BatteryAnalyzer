/** Plotly figures. */
import type { AggRow, EfficiencyDay, FullCycle, SizePoint } from "../core/analysis";
import { MONTHS, WEEKDAYS, type Period, addDays, dateOfDayKey, weekday } from "./dates";
import { fmt } from "./format";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Trace = Record<string, any>;
export interface Figure {
  data: Trace[];
  layout: Record<string, any>;
}

// Colours: yellow = production, blue = own supply, red = grid import.
// Validated with the dataviz palette checker (adjacent CVD ΔE ≥ 18 in both modes).
export interface Theme {
  surface: string; ink: string; ink2: string; muted: string; grid: string; axis: string;
  pv: string; own: string; gridIn: string;
}
export const THEMES: Record<"light" | "dark", Theme> = {
  light: { surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e9e8e3", axis: "#c3c2b7",
    pv: "#e0a000", own: "#1f8fbf", gridIn: "#e34948" },
  dark: { surface: "#25262b", ink: "#ffffff", ink2: "#c3c2b7", muted: "#9a9ca3", grid: "#33353b", axis: "#3d3f46",
    pv: "#c98500", own: "#2e95bd", gridIn: "#e8483f" },
};

// Fixed left gutter for the stacked energy / cost bar charts so their plot areas line up in x
// (automargin would size it to each chart's tick labels, e.g. "40 kWh" vs "CHF 1'500").
const BAR_GUTTER = 84;
const HOUR_MS = 3_600_000;

export function barGap(period: Period): number {
  return period === "day" ? 0.15 : period === "week" ? 0.6 : 0.42;
}

function axis(t: Theme): Record<string, any> {
  return { gridcolor: t.grid, linecolor: t.axis, zerolinecolor: t.axis, tickfont: { color: t.muted },
    title: { font: { color: t.ink2 } } };
}

export function baseLayout(t: Theme, height: number): Record<string, any> {
  return {
    height, paper_bgcolor: t.surface, plot_bgcolor: t.surface,
    font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: t.ink2, size: 13 },
    margin: { l: 56, r: 16, t: 40, b: 40 }, separators: ".'",
    legend: { orientation: "h", yanchor: "bottom", y: 1.02, x: 0, font: { color: t.ink2 } },
    hoverlabel: { bgcolor: t.surface, font: { color: t.ink }, bordercolor: t.axis },
    xaxis: axis(t), yaxis: axis(t),
  };
}

/** Grid import (red) that a bigger battery turns into own supply (blue): blue diagonal on red.
 * Own supply (blue) that a smaller battery turns into grid import (red): red crosshatch on blue. */
function pattern(t: Theme, smaller = false): Record<string, any> {
  return smaller
    ? { shape: "x", bgcolor: t.own, fgcolor: t.gridIn, size: 8, solidity: 0.4, fillmode: "replace" }
    : { shape: "/", bgcolor: t.gridIn, fgcolor: t.own, size: 8, solidity: 0.5, fillmode: "replace" };
}

export function compareLabel(capacity: number): string {
  return capacity === 0 ? "ohne Batterie" : `mit ${capacity} kWh`;
}

/** Bars of a period: one entry per bucket, undefined where there is no data. */
export interface Buckets {
  x: (string | number)[];
  keys: string[]; // customdata: click target ("YYYY-MM-DD") or slot label
  rows: (AggRow | undefined)[];
}

const col = (b: Buckets, f: (r: AggRow) => number) => b.rows.map((r) => (r ? f(r) : null));

/** A production bar next to a consumption bar (own | changed | grid). */
function energyBars(b: Buckets, capacity: number, real: number, t: Theme, cell: Record<string, any> = {}): Trace[] {
  const dec = cell.yaxis ? 2 : 1; // 15-min slots hold small values
  const bar = (y: (number | null)[], name: string, group: string, marker: Trace, base?: (number | null)[]): Trace => ({
    type: "bar", x: b.x, y, base, offsetgroup: group, name, marker: { ...marker, line: { width: 0 } },
    customdata: b.keys, hovertemplate: `%{y:,.${dec}f} kWh`, ...cell,
  });
  const own = (r: AggRow) => r.pv_direct + r.batt_to_load;
  const traces = [bar(col(b, (r) => r.production), "Produktion", "P", { color: t.pv })];
  if (capacity < real) {
    // Part of the real own supply that the smaller battery could not deliver
    traces.push(
      bar(col(b, (r) => own(r) + r.extra_discharged), "Eigenversorgung", "V", { color: t.own }),
      bar(col(b, (r) => -r.extra_discharged), `Zusätzlicher Netzbezug (${compareLabel(capacity)})`, "V",
        { color: t.own, pattern: pattern(t, true) }, col(b, (r) => own(r) + r.extra_discharged)),
      bar(col(b, (r) => r.grid_to_load), "Netzbezug", "V", { color: t.gridIn }, col(b, own)),
    );
    return traces;
  }
  traces.push(bar(col(b, own), "Eigenversorgung", "V", { color: t.own }));
  if (capacity > real) {
    traces.push(bar(col(b, (r) => r.extra_discharged), `Vermiedener Netzbezug (${capacity} kWh)`, "V",
      { color: t.gridIn, pattern: pattern(t) }, col(b, own)));
  }
  traces.push(bar(col(b, (r) => r.grid_scen), "Netzbezug", "V", { color: t.gridIn },
    col(b, (r) => own(r) + r.extra_discharged)));
  return traces;
}

/** Week / month / year axis: one bucket per day (per month in the year view). */
export function barAxis(period: Period, buckets: string[]): Pick<Buckets, "x" | "keys"> {
  const x = buckets.map((d) => {
    if (period === "year") return MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3);
    if (period === "week") return `${WEEKDAYS[weekday(d)].slice(0, 2)} ${d.slice(8, 10)}.`;
    return d.slice(8, 10);
  });
  return { x, keys: buckets };
}

/** Day axis: one bar per 15-min slot, centred on its slot (local naive time strings). */
export function dayAxis(day: string): Pick<Buckets, "x" | "keys"> & { slots: string[] } {
  const slots: string[] = [], x: string[] = [], keys: string[] = [];
  for (let m = 0; m < 24 * 60; m += 15) {
    const hm = (v: number) => `${String(Math.floor(v / 60) % 24).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
    slots.push(`${day} ${hm(m)}`);
    x.push(`${day} ${hm(m + 7)}:30`);
    keys.push(`${hm(m)}–${hm(m + 15)}`);
  }
  return { x, keys, slots };
}

function dayRangeX(day: string): [string, string] {
  return [`${day} 00:00`, `${addDays(day, 1)} 00:00`];
}

export function barFigure(b: Buckets, period: Period, capacity: number, real: number, t: Theme): Figure {
  const layout = baseLayout(t, 480);
  Object.assign(layout.yaxis, { ticksuffix: " kWh", rangemode: "tozero", automargin: false });
  Object.assign(layout.xaxis, { showgrid: true, tickangle: 0, type: "category" });
  layout.margin.l = BAR_GUTTER;
  return { data: energyBars(b, capacity, real, t),
    layout: { ...layout, barmode: "group", bargap: barGap(period), bargroupgap: 0, hovermode: "x unified" } };
}

export interface SocSeries {
  x: string[]; // end of slot, local naive
  real: (number | null)[]; // kWh
  sim?: (number | null)[];
}

/** Day: one bar pair per 15-min slot, battery content below. */
export function dayFigure(day: string, b: Buckets, soc: SocSeries, capacity: number, real: number, t: Theme): Figure {
  const traces = energyBars(b, capacity, real, t, { xaxis: "x", yaxis: "y" });
  traces.push({ type: "scatter", mode: "lines", x: soc.x, y: soc.real, name: `Batterie Ist (${real} kWh)`,
    line: { color: t.ink2, width: 2 }, hovertemplate: "%{y:.1f} kWh", xaxis: "x", yaxis: "y2" });
  if (soc.sim) {
    traces.push({ type: "scatter", mode: "lines", x: soc.x, y: soc.sim, name: `Batterie ${capacity} kWh (Simulation)`,
      line: { color: t.own, width: 2 }, hovertemplate: "%{y:.1f} kWh", xaxis: "x", yaxis: "y2" });
  }
  const layout = baseLayout(t, 680);
  const ax = axis(t);
  // Two rows sharing x (heights 0.68 / 0.32, spacing 0.1), titles above each row
  layout.xaxis = { ...ax, anchor: "y2", tickformat: "%H:%M", dtick: 3 * HOUR_MS, hoverformat: "%H:%M",
    range: dayRangeX(day), type: "date" };
  layout.yaxis = { ...ax, domain: [0.388, 1], rangemode: "tozero", automargin: false, ticksuffix: " kWh" };
  layout.yaxis2 = { ...ax, domain: [0, 0.288], rangemode: "tozero", automargin: false };
  layout.margin.l = BAR_GUTTER;
  layout.legend = { ...layout.legend, y: 1.08, traceorder: "normal" };
  const title = (text: string, y: number) => ({ text, x: 0, xref: "paper", xanchor: "left", y, yref: "paper",
    yanchor: "bottom", showarrow: false, font: { color: t.ink2, size: 13 } });
  layout.annotations = [title("Energie pro 15 Minuten", 1), title("Batterieinhalt (kWh)", 0.288)];
  return { data: traces, layout: { ...layout, barmode: "group", bargap: barGap("day"), bargroupgap: 0,
    hovermode: "x unified" } };
}

/** Saved cost per bar: avoided import cost up, feed-in revenue given up down, net as a marker. */
export function costFigure(b: Buckets, period: Period, day: string, capacity: number, real: number,
  t: Theme): Figure {
  const sd = capacity !== real;
  const gain = col(b, (r) => (sd ? r.saved_import : r.batt_saved));
  const loss = col(b, (r) => (sd ? r.lost_export : r.batt_lost));
  const names = capacity < real // both negative: extra import cost down, extra feed-in up
    ? ["Zusätzliche Bezugskosten", "Zusätzliche Einspeisevergütung", "Ersparnis netto (negativ = Mehrkosten)"]
    : sd ? ["Vermiedene Bezugskosten", "Entgangene Einspeisevergütung", "Ersparnis netto"]
      : ["Vermiedene Bezugskosten", "Entgangene Einspeisevergütung + Netzladung", "Ersparnis netto"];
  const common = { x: b.x, customdata: b.keys, hovertemplate: "CHF %{y:,.2f}" };
  const data: Trace[] = [
    { type: "bar", y: gain, name: names[0], marker: { color: t.own, line: { width: 0 } }, ...common },
    { type: "bar", y: loss.map((v) => (v === null ? null : -v)), name: names[1],
      marker: { color: t.pv, line: { width: 0 } }, ...common },
    { type: "scatter", mode: "markers", y: gain.map((g, i) => (g === null ? null : g - loss[i]!)), name: names[2],
      ...common, marker: { symbol: "diamond", size: period === "day" ? 7 : 10, color: t.ink,
        line: { width: 2, color: t.surface } } },
  ];
  const layout = baseLayout(t, 340);
  // Up to two decimals, trailing zeros trimmed: daily amounts are often below CHF 1
  Object.assign(layout.yaxis, { automargin: false, tickprefix: "CHF ", tickformat: ",.2~f" });
  Object.assign(layout.xaxis, { showgrid: true, tickangle: 0 });
  layout.margin.l = BAR_GUTTER;
  if (period === "day") {
    Object.assign(layout.xaxis, { type: "date", tickformat: "%H:%M", dtick: 3 * HOUR_MS, hoverformat: "%H:%M",
      range: dayRangeX(day) });
  } else {
    layout.xaxis.type = "category";
  }
  return { data, layout: { ...layout, barmode: "relative", bargap: barGap(period), hovermode: "x unified" } };
}

export function curveFigure(curve: SizePoint[], capacity: number, t: Theme): Figure {
  const data: Trace[] = [{
    type: "scatter", mode: "lines", x: curve.map((p) => p.capacity), y: curve.map((p) => p.avoided),
    name: "Vermiedener Netzbezug", line: { color: t.own, width: 2 },
    customdata: curve.map((p) => [p.autarky, p.saving]),
    hovertemplate: "%{x} kWh: <b>%{y:+,.0f} kWh</b> vermiedener Netzbezug ggü. Ist"
      + "<br>CHF %{customdata[1]:+,.0f} Ersparnis ggü. Ist<br>Autarkie %{customdata[0]:.1f} %<extra></extra>",
  }];
  const layout = baseLayout(t, 300);
  const sel = curve.find((p) => p.capacity === capacity);
  if (sel) {
    data.push({ type: "scatter", mode: "markers", x: [sel.capacity], y: [sel.avoided], showlegend: false,
      hoverinfo: "skip", marker: { size: 11, color: t.own, line: { width: 2, color: t.surface } } });
    layout.annotations = [{ x: sel.capacity, y: sel.avoided, text: `${fmt(sel.avoided)} kWh`, showarrow: false,
      yshift: 16, font: { color: t.ink, size: 13 } }];
  }
  layout.xaxis = { ...layout.xaxis, title: { ...layout.xaxis.title, text: "Batteriekapazität (kWh)" }, dtick: 5 };
  layout.yaxis = { ...layout.yaxis, title: { ...layout.yaxis.title, text: "kWh weniger Netzbezug ggü. Ist" },
    zeroline: true };
  return { data, layout: { ...layout, showlegend: false } };
}

/** Daily round-trip efficiency of the real battery (dots) with the 30-day average. */
export function efficiencyFigure(eff: EfficiencyDay[], t: Theme): Figure {
  const x = eff.map((d) => dateOfDayKey(d.dayKey));
  const name = "Roundtrip", color = t.ink2;
  const data: Trace[] = [
    { type: "scatter", mode: "markers", x, y: eff.map((d) => d.roundTrip), name, legendgroup: "roundTrip",
      showlegend: false, marker: { size: 5, color, opacity: 0.35 }, customdata: eff.map((d) => d.throughput),
      hovertemplate: `${name}: %{y:.1%} (Tag, %{customdata:.1f} kWh entladen)<extra></extra>` },
    { type: "scatter", mode: "lines", x, y: eff.map((d) => d.roundTripAvg), name, legendgroup: "roundTrip",
      line: { color, width: 2 }, hovertemplate: `${name}: %{y:.1%} (30 Tage)<extra></extra>` },
  ];
  const layout = baseLayout(t, 360);
  Object.assign(layout.yaxis, { tickformat: ".0%" });
  Object.assign(layout.xaxis, { hoverformat: "%d.%m.%Y", type: "date" });
  layout.shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 1, y1: 1,
    line: { color: t.axis, width: 1, dash: "dot" } }];
  return { data, layout: { ...layout, hovermode: "x unified" } };
}

/** AC kWh per full cycle (0 -> 100 % SOC), per charge and discharge, with 60-day medians. */
export function cycleFigure(cycles: FullCycle[], localTime: (ms: number) => string, real: number, t: Theme): Figure {
  const data: Trace[] = [];
  for (const [kind, name, color] of [["charge", "Laden (kWh AC hinein)", t.pv],
    ["discharge", "Entladen (kWh AC heraus)", t.own]] as const) {
    const c = cycles.filter((x) => x.kind === kind);
    const x = c.map((x) => localTime(x.start));
    data.push(
      { type: "scatter", mode: "markers", x, y: c.map((x) => x.kwhPerCycle), name, legendgroup: kind, showlegend: false,
        marker: { size: 7, color, opacity: 0.5, line: { width: 1, color: t.surface } }, customdata: c.map((x) => x.hours),
        hovertemplate: `${name}: %{y:.2f} kWh (Zyklus, %{customdata:.1f} h)<extra></extra>` },
      { type: "scatter", mode: "lines", x, y: c.map((x) => x.avg), name, legendgroup: kind, line: { color, width: 2 },
        hovertemplate: `${name}: %{y:.2f} kWh (60-Tage-Median)<extra></extra>` },
    );
  }
  const layout = baseLayout(t, 340);
  Object.assign(layout.yaxis, { ticksuffix: " kWh" });
  Object.assign(layout.xaxis, { hoverformat: "%d.%m.%Y", type: "date" });
  layout.shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: real, y1: real,
    line: { color: t.axis, width: 1, dash: "dot" } }];
  layout.annotations = [{ xref: "paper", x: 0, xanchor: "left", y: real, yanchor: "bottom",
    text: `${real} kWh nominal`, showarrow: false, font: { color: t.muted, size: 12 } }];
  return { data, layout: { ...layout, hovermode: "closest" } };
}
