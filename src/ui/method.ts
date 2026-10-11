/**
 * "Methode" view: fills in the parameter values from the code and draws the explanatory charts from two
 * real example days (scaled, see example-days.ts). They go through the app's own loader and simulation, so
 * the charts always show what the analysis really computes.
 */
import Plotly from "plotly.js-basic-dist-min";
import { aggregate, flows, sizeCurve } from "../core/analysis";
import { type Dataset, type Row, datasetFromRows } from "../core/data";
import { DEFAULT_POWER, type SimResult, batteryParams, powerStep, realContentWh, simulate } from "../core/sim";
import { DAY_TYPES, DEFAULT_SCHEDULE, DEFAULT_TARIFF, isHighTariff } from "../core/tariff";
import { MONTHS } from "./dates";
import { EXAMPLE_DATES, EXAMPLE_DAYS, EXAMPLE_KWH } from "./example-days";
import { type Figure, type Theme, type Trace, baseLayout, dayAxis, dayFigure } from "./figures";
import { fmt } from "./format";

/** Battery sizes of the examples (kWh): the example's real battery, one half larger, one half smaller. */
const SAMPLE = { real: EXAMPLE_KWH, larger: EXAMPLE_KWH * 1.5, smaller: EXAMPLE_KWH * 0.5 };
const WEEKDAYS_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
// The two example days plus the next one, which ends the time axes
const DATES = [...EXAMPLE_DATES, nextDate(EXAMPLE_DATES[EXAMPLE_DATES.length - 1])];
const DAY_LABELS = DATES.map((d) => {
  const day = new Date(`${d}T12:00:00Z`);
  return `${WEEKDAYS_SHORT[day.getUTCDay()]} ${day.getUTCDate()}.${day.getUTCMonth() + 1}.`;
});

const pad = (n: number) => String(n).padStart(2, "0");
/** Fewer time ticks on phones, so the labels do not overlap. */
const tickHours = (wide: number) => (matchMedia("(max-width: 600px)").matches ? wide * 2 : wide);

function nextDate(d: string): string {
  return new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The example days as dataset rows (summer time, +02:00). */
function exampleRows(): Row[] {
  return EXAMPLE_DAYS.map(([consumption, production, battCharge, battDischarge, soc], i) => {
    const m = (i % 96) * 15;
    const local = `${EXAMPLE_DATES[Math.floor(i / 96)]}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    return { time: Date.parse(`${local}:00+02:00`), local, values: { consumption, production, battCharge, battDischarge, soc } };
  });
}

interface Sample {
  ds: Dataset;
  larger: SimResult;
  smaller: SimResult;
  realKwh: Float64Array; // real battery content (kWh)
  end: string[]; // interval ends, local naive time
}

function computeSample(): Sample {
  const ds = datasetFromRows(exampleRows());
  // Local naive time of interval i plus some seconds (the example days have no DST change)
  const at = (i: number, seconds: number) => {
    const total = i * 900 + seconds, r = total % 86400;
    return `${DATES[Math.floor(total / 86400)]} ${pad(Math.floor(r / 3600))}:${pad(Math.floor(r / 60) % 60)}:${pad(r % 60)}`;
  };
  return {
    ds,
    larger: simulate(ds, batteryParams(SAMPLE.larger, { realKwh: SAMPLE.real })),
    smaller: simulate(ds, batteryParams(SAMPLE.smaller, { realKwh: SAMPLE.real })),
    realKwh: realContentWh(ds, SAMPLE.real).map((v) => v / 1000),
    end: Array.from({ length: ds.n }, (_, i) => at(i, 900)),
  };
}

/** "15. und 16. August 2025" (the example days lie in one month). */
function exampleDatesText(): string {
  const [first, last] = [EXAMPLE_DATES[0], EXAMPLE_DATES[EXAMPLE_DATES.length - 1]];
  return `${Number(first.slice(8))}. und ${Number(last.slice(8))}. ${MONTHS[Number(last.slice(5, 7)) - 1]} ${last.slice(0, 4)}`;
}

/** Default high tariff times: "Mo–Fr 07–20 Uhr, Sa 07–13 Uhr" (day types without high tariff left out). */
function htTimesText(): string {
  const time = (m: number) => (m % 60 ? `${pad(Math.floor(m / 60))}:${pad(m % 60)}` : pad(m / 60));
  return DEFAULT_TARIFF.ht.flatMap((w, d) => (w ? [`${DAY_TYPES[d]} ${time(w.from)}–${time(w.to)}\u00a0Uhr`] : []))
    .join(", ");
}

const kw = (v: number) => fmt(v, Number.isInteger(v) ? 0 : 1);

/** Default power steps: "5 kW ab 0 kWh, 10 kW ab 15 kWh" (charge / discharge where they differ). */
function powerStepsText(): string {
  return DEFAULT_POWER.map((s) => `${kw(s.chargeKw)}${s.dischargeKw === s.chargeKw ? "" : ` / ${kw(s.dischargeKw)}`}`
    + `\u00a0kW ab ${kw(s.fromKwh)}\u00a0kWh`).join(", ");
}

/** Parameter values in the text, straight from the code. */
function fillParams(): void {
  const p = batteryParams(SAMPLE.real);
  const { chargeKw } = powerStep(batteryParams(SAMPLE.larger));
  const values: Record<string, string> = {
    fullSoc: fmt(p.fullSoc), emptySoc: fmt(p.emptySoc), socMin: fmt(p.socMin), socMax: fmt(p.socMax),
    efficiency: fmt(p.efficiency * 100), chargeEfficiency: fmt(p.chargeEfficiency * 100),
    samplePower: kw(chargeKw), powerSteps: powerStepsText(),
    sampleReal: fmt(SAMPLE.real), sampleLarger: fmt(SAMPLE.larger), sampleSmaller: fmt(SAMPLE.smaller),
    exampleDates: exampleDatesText(),
    htTimes: htTimesText(),
  };
  for (const el of document.querySelectorAll<HTMLElement>("#page-method [data-param]")) {
    el.textContent = values[el.dataset.param!] ?? el.textContent;
  }
}

function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Time axis over the given days: ticks every `step` hours, midnight labelled with the day. */
function timeAxis(layoutAxis: Record<string, unknown>, days: number, step: number): Record<string, unknown> {
  const vals: string[] = [], text: string[] = [];
  for (let h = 0; h <= days * 24; h += step) {
    const day = Math.floor(h / 24);
    vals.push(`${DATES[day]} ${pad(h % 24)}:00`);
    text.push(h % 24 === 0 ? DAY_LABELS[day] : `${pad(h % 24)}:00`);
  }
  return { ...layoutAxis, type: "date", tickmode: "array", tickvals: vals, ticktext: text, hoverformat: "%d.%m. %H:%M",
    range: [vals[0], vals[vals.length - 1]], showgrid: true };
}

function title(t: Theme, text: string, y: number): Record<string, unknown> {
  return { text, x: 0, xref: "paper", xanchor: "left", y, yref: "paper", yanchor: "bottom", showarrow: false,
    font: { color: t.ink2, size: 13 } };
}

/** Section 2: both days as in the Analyse day view (kWh per 15 minutes, battery content below). */
function flowsFigure(s: Sample, t: Theme): Figure {
  const fl = flows(s.ds, batteryParams(SAMPLE.real, { realKwh: SAMPLE.real }), DEFAULT_SCHEDULE);
  const axes = EXAMPLE_DATES.map((d) => dayAxis(d));
  const buckets = { x: axes.flatMap((a) => a.x), keys: axes.flatMap((a) => a.keys),
    rows: aggregate(s.ds, fl, [0, s.ds.n], "interval") };
  const fig = dayFigure(DATES[0], buckets, { x: s.end, real: Array.from(s.realKwh) }, SAMPLE.real, SAMPLE.real, t);
  // Same time axis over both days as the other charts on this page
  const { anchor } = fig.layout.xaxis;
  fig.layout.xaxis = { ...timeAxis(fig.layout.xaxis, EXAMPLE_DATES.length, tickHours(6)), anchor };
  return fig;
}

/** Section 4: real SOC with the thresholds, and the content of the add-on. */
function largerFigure(s: Sample, t: Theme): Figure {
  const p = batteryParams(SAMPLE.larger);
  const x = s.end;
  const data: Trace[] = [
    { type: "scatter", mode: "lines", x, y: Array.from(s.ds.soc), name: `Ladezustand reale Batterie (${SAMPLE.real} kWh)`,
      line: { color: t.ink2, width: 2 }, hovertemplate: "%{y:.0f} %", xaxis: "x", yaxis: "y" },
    { type: "scatter", mode: "lines", x, y: Array.from(s.larger.extraEnergy, (v) => v / 1000),
      name: `Inhalt Zusatzkapazität (${SAMPLE.larger - SAMPLE.real} kWh)`, line: { color: t.own, width: 2 },
      fill: "tozeroy", fillcolor: alpha(t.own, 0.2), hovertemplate: "%{y:.2f} kWh", xaxis: "x", yaxis: "y2" },
  ];
  const layout = baseLayout(t, 480);
  const ax = layout.yaxis;
  layout.xaxis = { ...timeAxis(layout.xaxis, 2, tickHours(6)), anchor: "y2" };
  layout.yaxis = { ...ax, domain: [0.56, 1], range: [0, 105], ticksuffix: " %" };
  layout.yaxis2 = { ...ax, domain: [0, 0.4], rangemode: "tozero", ticksuffix: " kWh" };
  layout.legend = { ...layout.legend, y: 1.1 };
  const threshold = (y: number) => ({ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: y, y1: y,
    line: { color: t.pv, width: 1.5, dash: "dash" } });
  const label = (y: number, text: string, anchor: string) => ({ xref: "paper", x: 1, xanchor: "right", yref: "y", y,
    yanchor: anchor, text, showarrow: false, font: { color: t.pv, size: 12 } });
  layout.shapes = [threshold(p.fullSoc), threshold(p.emptySoc)];
  layout.annotations = [
    label(p.fullSoc, `voll ≥ ${p.fullSoc} %`, "top"), label(p.emptySoc, `leer ≤ ${p.emptySoc} %`, "bottom"),
    title(t, "Ladezustand der realen Batterie", 1), title(t, "Inhalt der Zusatzkapazität", 0.4),
  ];
  return { data, layout: { ...layout, hovermode: "x unified" } };
}

/** Section 5: real content, content of the smaller battery and the gap between them. */
function smallerFigure(s: Sample, t: Theme): Figure {
  const x = s.end;
  const small = Array.from(s.realKwh, (v, i) => v + s.smaller.extraEnergy[i] / 1000);
  const data: Trace[] = [
    { type: "scatter", mode: "lines", x, y: small, name: `Inhalt kleinere Batterie (${SAMPLE.smaller} kWh)`,
      line: { color: t.own, width: 2 }, fill: "tozeroy", fillcolor: alpha(t.own, 0.2), hovertemplate: "%{y:.2f} kWh" },
    { type: "scatter", mode: "lines", x, y: Array.from(s.realKwh), name: `Inhalt reale Batterie (${SAMPLE.real} kWh)`,
      line: { color: t.ink2, width: 2 }, fill: "tonexty", fillcolor: alpha(t.gridIn, 0.3), hovertemplate: "%{y:.2f} kWh" },
  ];
  const layout = baseLayout(t, 360);
  layout.xaxis = timeAxis(layout.xaxis, 2, tickHours(6));
  Object.assign(layout.yaxis, { ticksuffix: " kWh", rangemode: "tozero" });
  layout.shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: SAMPLE.smaller, y1: SAMPLE.smaller,
    line: { color: t.own, width: 1.5, dash: "dash" } }];
  layout.annotations = [{ xref: "paper", x: 0.01, xanchor: "left", y: SAMPLE.smaller, yanchor: "bottom",
    text: `K = ${SAMPLE.smaller} kWh`, showarrow: false, font: { color: t.own, size: 12 } },
  { xref: "paper", x: 0.01, xanchor: "left", y: SAMPLE.real * 0.95, yanchor: "top", text: "rote Fläche: Lücke g",
    showarrow: false, font: { color: t.gridIn, size: 12 } }];
  return { data, layout: { ...layout, hovermode: "x unified" } };
}

/** Section 6: one week of example prices (HT / NT). */
function tariffFigure(t: Theme): Figure {
  const tariff = DEFAULT_TARIFF;
  const x: string[] = [], imp: number[] = [], exp: number[] = [];
  const start = Date.UTC(2026, 5, 15);
  for (let q = 0; q <= 7 * 96; q++) {
    const d = new Date(start + q * 900_000);
    const weekday = (d.getUTCDay() + 6) % 7;
    const ht = isHighTariff(tariff, weekday, d.getUTCHours() * 60 + d.getUTCMinutes());
    x.push(`${d.toISOString().slice(0, 10)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`);
    imp.push(ht ? tariff.importHt : tariff.importNt);
    exp.push(ht ? tariff.exportHt : tariff.exportNt);
  }
  const step = (y: number[], name: string, color: string): Trace => ({ type: "scatter", mode: "lines", x, y, name,
    line: { color, width: 2, shape: "hv" }, hovertemplate: "%{y:.2f} CHF/kWh" });
  const layout = baseLayout(t, 280);
  const days = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  layout.xaxis = { ...layout.xaxis, type: "date", tickmode: "array", showgrid: true, hoverformat: "%d.%m. %H:%M",
    tickvals: days.map((_, i) => `2026-06-${15 + i} 12:00`), ticktext: days, range: [x[0], x[x.length - 1]] };
  Object.assign(layout.yaxis, { tickformat: ".2f", ticksuffix: " CHF", rangemode: "tozero" });
  return { data: [step(imp, "Bezug", t.gridIn), step(exp, "Einspeisung", t.pv)],
    layout: { ...layout, hovermode: "x unified" } };
}

/** Section 7: size curve over the two sample days. */
function curveFigure(s: Sample, t: Theme): Figure {
  const sizes = Array.from({ length: 21 }, (_, i) => i);
  const curve = sizeCurve(s.ds, [0, s.ds.n], sizes, DEFAULT_SCHEDULE, { realKwh: SAMPLE.real });
  const real = curve.find((p) => p.capacity === SAMPLE.real)!;
  const data: Trace[] = [
    { type: "scatter", mode: "lines+markers", x: sizes, y: curve.map((p) => p.avoided), name: "Vermiedener Netzbezug",
      line: { color: t.own, width: 2 }, marker: { size: 5, color: t.own },
      hovertemplate: "%{x} kWh: %{y:+.1f} kWh<extra></extra>" },
  ];
  const layout = baseLayout(t, 300);
  layout.xaxis = { ...layout.xaxis, title: { ...layout.xaxis.title, text: "Batteriegrösse K (kWh)" }, dtick: 2 };
  layout.yaxis = { ...layout.yaxis, title: { ...layout.yaxis.title, text: "kWh weniger Netzbezug" }, zeroline: true };
  layout.annotations = [{ x: real.capacity, y: real.avoided, text: `reale Grösse ${SAMPLE.real} kWh`, showarrow: true,
    arrowcolor: t.muted, ax: 0, ay: -36, font: { color: t.ink2, size: 12 } }];
  return { data, layout: { ...layout, showlegend: false } };
}

let sample: Sample | null = null;

function draw(id: string, fig: Figure): void {
  const div = document.getElementById(id)!;
  div.style.height = `${fig.layout.height}px`;
  void Plotly.react(div, fig.data as Plotly.Data[], fig.layout as Partial<Plotly.Layout>,
    { displaylogo: false, responsive: true, displayModeBar: false });
}

/** Draw the view (the sample is computed on first use). */
export function renderMethod(t: Theme): void {
  if (!sample) {
    fillParams();
    sample = computeSample();
  }
  draw("method-flows", flowsFigure(sample, t));
  draw("method-larger", largerFigure(sample, t));
  draw("method-smaller", smallerFigure(sample, t));
  draw("method-tariff", tariffFigure(t));
  draw("method-curve", curveFigure(sample, t));
}
