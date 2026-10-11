/** Battery analyser UI: loads measurement files locally and renders everything in the browser. */
import "./style.css";
import Plotly from "plotly.js-basic-dist-min";
import {
  type AggRow, FLOW_KEYS, type Flows, type SizePoint, aggregate, batteryEfficiency, dayRange, derive, emptyAggRow,
  flows, fullCycles, kpis, sumFlows, timeRange,
} from "./core/analysis";
import { type Dataset, type ExportFile, loadExports, supportedFormats } from "./core/data";
import {
  type BatteryParams, DEFAULT_POWER, DEFAULT_REAL_KWH, type PowerStep, type SimResult, batteryParams, simulate,
} from "./core/sim";
import { DEFAULT_TARIFF, type Schedule, type TariffPeriod, yearPeriod } from "./core/tariff";
import type { CurveRequest, CurveResponse } from "./curve.worker";
import {
  MONTHS, PERIODS, type Period, WEEKDAYS, clampDate, dateOfDayKey, dayKeyOf, formatDateCh, periodBuckets,
  periodLabel, periodRange, step, weekday,
} from "./ui/dates";
import {
  type Buckets, type Figure, type SocSeries, THEMES, barAxis, barFigure, compareLabel, costFigure, curveFigure,
  cycleFigure, dayAxis, dayFigure, efficiencyFigure,
} from "./ui/figures";
import { TRASH_ICON, el } from "./ui/dom";
import { fmt } from "./ui/format";
import { renderMethod } from "./ui/method";
import { isPowerSteps, renderPowerSteps } from "./ui/power-editor";
import {
  deleteAllDatasets, deleteDataset, listDatasets, loadSettings, openDataset, saveDataset, saveSettings,
} from "./ui/storage";
import { isSchedule, renderTariffs } from "./ui/tariff-editor";

const SIZES = Array.from({ length: 41 }, (_, i) => i);

type Tab = "data" | "analysis" | "battery" | "method";
const TAB_PARAM: Record<Tab, string> = { data: "daten", analysis: "analyse", battery: "batterie", method: "methode" };
const needsData = (tab: Tab) => tab === "analysis" || tab === "battery";
interface Settings {
  tab: Tab;
  period: Period;
  date: string | null;
  capacity: number;
  realKwh: number | null;
  eff: number | null; // %
  socMin: number | null;
  socMax: number | null;
  power: PowerStep[] | null; // null: not edited yet, DEFAULT_POWER
  tariffs: TariffPeriod[] | null; // null: not edited yet, see defaultTariffs()
  prices?: Record<string, Partial<Record<PriceKey, number>>>; // earlier version: Rp./kWh per year
}
type PriceKey = "importHt" | "importNt" | "exportHt" | "exportNt" | "feeMonth";
const DEFAULTS: Settings = {
  tab: "analysis", period: "month", date: null, capacity: 15, realKwh: DEFAULT_REAL_KWH, eff: 81, socMin: 0, socMax: 100, power: null,
  tariffs: null,
};

const state: Settings = { ...DEFAULTS, ...loadSettings<Settings>() };
// Settings of earlier versions
for (const key of ["remember", "powerKw"]) delete (state as unknown as Record<string, unknown>)[key];
if (!isSchedule(state.tariffs)) state.tariffs = null;
if (!isPowerSteps(state.power)) state.power = null; // also the per-size table of an earlier version
applyUrl(new URLSearchParams(location.search));

// ---------------------------------------------------------------- DOM helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function plot(id: string, fig: Figure, onClick?: (ev: Plotly.PlotMouseEvent) => void): void {
  const div = $(id);
  div.querySelector(".placeholder")?.remove();
  // The container takes the figure's height; with responsive mode Plotly only follows its width
  div.style.height = `${fig.layout.height}px`;
  void Plotly.react(div, fig.data as Plotly.Data[], fig.layout as Partial<Plotly.Layout>,
    { displaylogo: false, responsive: true });
  if (onClick) {
    // Plotly.purge drops all listeners, so attach on every draw (react sets up .on() synchronously)
    const gd = div as unknown as Plotly.PlotlyHTMLElement;
    gd.removeAllListeners("plotly_click");
    gd.on("plotly_click", onClick);
  }
}

function placeholder(id: string, text: string): void {
  Plotly.purge($(id));
  $(id).style.height = "";
  $(id).replaceChildren(el("p", "muted placeholder", text));
}

function theme() {
  return matchMedia("(prefers-color-scheme: dark)").matches ? THEMES.dark : THEMES.light;
}

// ---------------------------------------------------------------- data

let ds: Dataset | null = null;
let firstDay = "", lastDay = "";
let years: number[] = [];

const pad = (n: number) => String(n).padStart(2, "0");
const minuteOf = (i: number) => new Date(ds!.time[i]).getUTCMinutes(); // offsets are whole hours

/** Local start of interval i as "YYYY-MM-DD HH:MM". */
function localStart(i: number): string {
  return `${dateOfDayKey(ds!.dayKey[i])} ${pad(ds!.hour[i])}:${pad(minuteOf(i))}`;
}

/**
 * Use a newly read dataset; `show` switches to that view (null: stay in the current one). The analysis
 * then starts on the overview of the current (latest) year.
 */
function setDataset(d: Dataset, show: Tab | null): void {
  ds = d;
  scenario = null;
  curveData = null;
  curvePending = null;
  dsInWorker = false;
  batteryFigures = null;
  firstDay = dateOfDayKey(d.dayKey[0]);
  lastDay = dateOfDayKey(d.dayKey[d.n - 1]);
  years = [];
  for (let y = d.year[0]; y <= d.year[d.n - 1]; y++) years.push(y);
  if (show === "analysis") {
    state.period = "year";
    state.date = lastDay;
  } else state.date = clampDate(state.date ?? lastDay, firstDay, lastDay);
  $("data-range").textContent = `Daten ${formatDateCh(firstDay)} – ${formatDateCh(lastDay)}`;
  const date = $<HTMLInputElement>("date");
  date.min = firstDay;
  date.max = lastDay;
  drawTariffs();
  if (show) state.tab = show;
  render();
}

/** Drop the loaded data everywhere (page, worker, charts); settings stay. */
function unloadDataset(): void {
  ds = null;
  openId = null;
  scenario = null;
  curveData = null;
  curvePending = null;
  batteryFigures = null;
  if (dsInWorker) worker.postMessage({ clear: true });
  dsInWorker = false;
  for (const id of ["main", "cost", "curve", "cycles", "efficiency"]) Plotly.purge($(id));
  for (const id of ["tiles", "table"]) $(id).replaceChildren();
  $("data-range").textContent = "";
  years = [];
  drawTariffs();
  render();
}

/** Id of the stored dataset that is open (null: none, or it could not be stored). */
let openId: string | null = null;

function setStatus(text: string, error = false): void {
  $("start-status").className = error ? "small error" : "muted small";
  $("start-status").textContent = text;
}

/** Read one export file; null (with the reason shown on the start screen) if it cannot be read. */
async function readExport(file: ExportFile): Promise<Dataset | null> {
  setStatus("Daten werden gelesen …");
  try {
    const d = await loadExports([file]);
    setStatus("");
    return d;
  } catch (e) {
    setStatus(`Die Datei konnte nicht gelesen werden: ${(e as Error).message}`, true);
    showDataView();
    return null;
  }
}

/** A newly chosen file: open it in the analysis and keep it in the browser. */
async function openFile(file: ExportFile): Promise<void> {
  const d = await readExport(file);
  if (!d) return;
  const saved = await saveDataset(file, dateOfDayKey(d.dayKey[0]), dateOfDayKey(d.dayKey[d.n - 1]));
  openId = saved?.id ?? null;
  setDataset(d, "analysis");
  if (!saved) $("data-range").textContent += " · konnte nicht im Browser gespeichert werden";
  void refreshSaved();
}

/** A stored dataset: open it (or, if it is the open one, just show it); `show` as in setDataset. */
async function openStored(id: string, show: Tab | null): Promise<void> {
  if (id === openId && ds) {
    if (show) state.tab = show;
    render();
    return;
  }
  const file = await openDataset(id);
  if (!file) {
    setStatus("Die gespeicherten Daten konnten nicht gelesen werden.", true);
    showDataView();
    void refreshSaved();
    return;
  }
  const d = await readExport(file);
  if (!d) return;
  openId = id;
  setDataset(d, show);
}

async function fromFileList(list: FileList | null): Promise<void> {
  if (!list || list.length === 0) return;
  if (list.length > 1) {
    setStatus("Bitte nur eine Datei wählen.", true);
    return;
  }
  await openFile({ name: list[0].name, data: new Uint8Array(await list[0].arrayBuffer()) });
}

function fileSize(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

/** List of the datasets kept in this browser, most recently used first (hidden when there are none). */
async function refreshSaved(): Promise<void> {
  const list = await listDatasets();
  $("saved").hidden = list.length === 0;
  $("saved-list").replaceChildren(...list.map((s) => {
    const at = new Date(s.savedAt);
    const info = [`${formatDateCh(s.first)} – ${formatDateCh(s.last)}`, fileSize(s.size),
      `gespeichert ${at.toLocaleDateString("de-CH")} ${at.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })}`];
    const name = el("span", "ds-name", s.name);
    if (s.id === openId && ds) name.append(el("span", "ds-current", " · geöffnet"));
    const open = el("button", "ds-open", name, el("span", "ds-info", info.join(" · ")));
    open.setAttribute("type", "button");
    open.addEventListener("click", () => void openStored(s.id, "analysis"));
    const del = el("button", "ds-del");
    del.setAttribute("type", "button");
    del.title = "Löschen";
    del.setAttribute("aria-label", `${s.name} löschen`);
    del.innerHTML = TRASH_ICON;
    del.addEventListener("click", () => void forget(s.id));
    return el("li", "", open, del);
  }));
}

/** Delete one stored dataset (or all); the open one is unloaded as well. */
async function forget(id: string | null): Promise<void> {
  if (id) await deleteDataset(id);
  else await deleteAllDatasets();
  if (ds && (id === null || id === openId)) unloadDataset();
  setStatus(id ? "Die Datei wurde aus diesem Browser gelöscht." : "Alle Daten wurden aus diesem Browser gelöscht.");
  await refreshSaved();
}

/** The view to show: the chosen one, or "Daten" while a view that needs data has none. */
function view(): Tab {
  return needsData(state.tab) && !ds ? "data" : state.tab;
}

function showView(): void {
  const v = view();
  for (const b of $("tab").querySelectorAll<HTMLButtonElement>("button")) {
    const tab = b.dataset.value as Tab;
    b.setAttribute("aria-selected", String(tab === v));
    b.disabled = needsData(tab) && !ds;
    b.title = b.disabled ? "Zuerst Daten laden" : "";
  }
  const pages: [string, Tab][] = [["page-data", "data"], ["page-analysis", "analysis"], ["page-battery", "battery"],
    ["page-method", "method"]];
  for (const [id, tab] of pages) $(id).hidden = tab !== v;
  // The period only next to the views that show the data (the "Daten" list shows it per dataset);
  // invisible rather than hidden, so the header keeps its layout
  $("data-range").classList.toggle("invisible", !needsData(v));
}

function showDataView(): void {
  state.tab = "data";
  render();
}

// ---------------------------------------------------------------- model

/** Nominal capacity of the real battery, whole kWh like the size slider. */
function realKwh(): number {
  return Math.min(Math.max(Math.round(state.realKwh || DEFAULT_REAL_KWH), 1), 40);
}

function model(): Partial<BatteryParams> {
  return {
    realKwh: realKwh(), efficiency: (state.eff || 81) / 100, socMin: state.socMin || 0, socMax: state.socMax || 100,
    power: state.power ?? DEFAULT_POWER,
  };
}

function schedule(): Schedule {
  return state.tariffs ?? defaultTariffs();
}

/** Until the tariff is edited: one period over all years of the data with the example prices (or, if an
 * earlier version stored prices per year in Rp./kWh, one period per year with those). */
function defaultTariffs(): TariffPeriod[] {
  const ys = years.length ? years : [new Date().getFullYear()];
  if (!Object.keys(state.prices ?? {}).length) {
    return [{ ...yearPeriod(ys[0], DEFAULT_TARIFF), to: `${ys[ys.length - 1]}-12-31` }];
  }
  return ys.map((y) => {
    const old = state.prices?.[y] ?? {};
    const rp = (k: Exclude<PriceKey, "feeMonth">) => (old[k] === undefined ? DEFAULT_TARIFF[k] : old[k] / 100);
    return yearPeriod(y, { ...DEFAULT_TARIFF, importHt: rp("importHt"), importNt: rp("importNt"),
      exportHt: rp("exportHt"), exportNt: rp("exportNt"), feeMonth: old.feeMonth ?? DEFAULT_TARIFF.feeMonth });
  });
}

let scenario: { key: string; sim: SimResult; flows: Flows } | null = null;

function currentScenario(): { sim: SimResult; flows: Flows } {
  const p = batteryParams(state.capacity, model());
  const sched = schedule();
  const key = JSON.stringify([p, sched]);
  if (scenario?.key !== key) {
    const sim = simulate(ds!, p);
    scenario = { key, sim, flows: flows(ds!, p, sched, sim) };
  }
  return scenario;
}

// ---------------------------------------------------------------- size curve (web worker)

const worker = new Worker(new URL("./curve.worker.ts", import.meta.url), { type: "module" });
let dsInWorker = false;
let curveId = 0;
let curvePending: string | null = null;
let curveData: { key: string; days: Int32Array; sums: Float64Array } | null = null;
const curveKeys = new Map<number, string>();

worker.onmessage = (e: MessageEvent<CurveResponse>) => {
  const key = curveKeys.get(e.data.id);
  curveKeys.delete(e.data.id);
  if (e.data.id !== curveId || !key) return; // superseded by a newer request
  curveData = { key, days: e.data.days, sums: e.data.sums };
  curvePending = null;
  if (view() === "analysis") renderCurve();
};

function curveKey(): string {
  return JSON.stringify([model(), schedule()]);
}

function requestCurve(): void {
  const key = curveKey();
  if (curveData?.key === key || curvePending === key) return;
  curvePending = key;
  curveKeys.set(++curveId, key);
  const req: CurveRequest = { id: curveId, sizes: SIZES, model: model(), schedule: schedule() };
  if (!dsInWorker) {
    req.ds = ds!;
    dsInWorker = true;
  }
  worker.postMessage(req);
}

function lowerBound(a: Int32Array, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Size curve of the days [startKey, endKey) from the worker's daily sums. */
function curveForDays(startKey: number, endKey: number): SizePoint[] {
  const { days, sums } = curveData!;
  const k = FLOW_KEYS.length, from = lowerBound(days, startKey), to = lowerBound(days, endKey);
  return SIZES.map((size, s) => {
    const row = emptyAggRow();
    for (let d = from; d < to; d++) {
      const base = (s * days.length + d) * k;
      FLOW_KEYS.forEach((key, j) => (row[key] += sums[base + j]));
    }
    derive(row);
    return { capacity: size, avoided: row.extra_discharged, saving: row.saving, autarky: kpis(row).autarky[1] };
  });
}

// ---------------------------------------------------------------- rendering

function render(): void {
  showView();
  if (ds) {
    for (const b of $("period").querySelectorAll("button")) {
      b.setAttribute("aria-selected", String(b.dataset.value === state.period));
    }
    $<HTMLInputElement>("date").value = state.date!;
    $<HTMLInputElement>("capacity").value = String(state.capacity);
    $("capacity-value").textContent = String(state.capacity);
    $("real-value").textContent = String(realKwh());
  }
  if (view() === "analysis") renderAnalysis();
  else if (view() === "battery") renderBattery();
  else if (view() === "method") renderMethod(theme());
  persist();
}

function persist(): void {
  saveSettings(state);
  const q = new URLSearchParams({ tab: TAB_PARAM[view()] });
  if (ds) {
    q.set("period", state.period);
    q.set("date", state.date!);
    q.set("size", String(state.capacity));
  }
  history.replaceState(null, "", `?${q}`);
}

function period(): { start: string; end: string; range: [number, number]; label: string } {
  const { start, end } = periodRange(state.period, state.date!);
  return { start, end, range: dayRange(ds!, dayKeyOf(start), dayKeyOf(end)),
    label: periodLabel(state.period, start, end) };
}

function renderAnalysis(): void {
  const t = theme();
  const { start, end, range, label } = period();
  const sc = currentScenario();
  const total = aggregate(ds!, sc.flows, range, "none")[0];
  $("period-label").textContent = label;
  $("tiles").replaceChildren(...tiles(total));

  if (state.period === "day") {
    const b = dayBuckets(range, sc.flows);
    plot("main", dayFigure(state.date!, b, socSeries(range, sc.sim), state.capacity, realKwh(), t));
    plot("cost", costFigure(b, "day", state.date!, state.capacity, realKwh(), t));
  } else {
    const b = periodBucketsOf(start, end, range, sc.flows);
    plot("main", barFigure(b, state.period, state.capacity, realKwh(), t), drillDown);
    plot("cost", costFigure(b, state.period, state.date!, state.capacity, realKwh(), t), drillDown);
  }
  $("cost-title").textContent = `${costTitle()} · ${label}`;
  $("curve-title").textContent = `Batteriegrösse im Vergleich · ${label}`;
  $("table").replaceChildren(table(range, sc.flows));
  renderCurve();
}

/** Click on a bar: drill down (year -> month, week / month -> day). */
function drillDown(ev: Plotly.PlotMouseEvent): void {
  const key = ev.points[0]?.customdata;
  if (state.period === "day" || typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
  state.date = clampDate(key, firstDay, lastDay);
  state.period = state.period === "year" ? "month" : "day";
  render();
}

function renderCurve(): void {
  if (!ds) return;
  const { start, end } = periodRange(state.period, state.date!);
  if (curveData?.key !== curveKey()) {
    requestCurve();
    if (!curveData) placeholder("curve", "Batteriegrössen werden berechnet …");
    return; // keep the previous curve until the new one arrives
  }
  plot("curve", curveFigure(curveForDays(dayKeyOf(start), dayKeyOf(end)), state.capacity, theme()));
}

function costTitle(): string {
  const real = realKwh();
  if (state.capacity > real) return `Ersparnis mit ${state.capacity} kWh gegenüber der Ist-Batterie`;
  if (state.capacity < real) return `Mehrkosten ${compareLabel(state.capacity)} gegenüber der Ist-Batterie`;
  return `Ersparnis durch die Ist-Batterie (${real} kWh)`;
}

/** Week / month / year: one bucket per day (per month in the year view). */
function periodBucketsOf(start: string, end: string, range: [number, number], fl: Flows): Buckets {
  const year = state.period === "year";
  const rows = new Map(aggregate(ds!, fl, range, year ? "month" : "day").map((r) => [r.key, r]));
  const buckets = periodBuckets(state.period, start, end);
  const keyOf = (d: string) => (year ? Number(d.slice(0, 4)) * 100 + Number(d.slice(5, 7)) : dayKeyOf(d));
  return { ...barAxis(state.period, buckets), rows: buckets.map((d) => rows.get(keyOf(d))) };
}

/** Day: one bucket per local 15-min slot (both intervals of the repeated DST hour share a slot). */
function dayBuckets(range: [number, number], fl: Flows): Buckets {
  const axis = dayAxis(state.date!);
  const raw = sumFlows(ds!, fl, range, "interval");
  const bySlot = new Map<string, AggRow>();
  raw.forEach((row, j) => {
    const slot = localStart(range[0] + j);
    const prev = bySlot.get(slot);
    if (prev) for (const k of FLOW_KEYS) prev[k] += row[k];
    else bySlot.set(slot, row);
  });
  bySlot.forEach(derive);
  return { x: axis.x, keys: axis.keys, rows: axis.slots.map((s) => bySlot.get(s)) };
}

/** Battery content at the end of each slot: real (from the SOC) and simulated. */
function socSeries([from, to]: [number, number], sim: SimResult): SocSeries {
  const x: string[] = [], real: (number | null)[] = [], simulated: (number | null)[] = [];
  for (let i = from; i < to; i++) {
    const mins = ds!.hour[i] * 60 + minuteOf(i) + 15;
    const day = dateOfDayKey(ds!.dayKey[i]);
    x.push(`${mins >= 1440 ? nextDay(day) : day} ${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`);
    const soc = ds!.soc[i];
    const r = Number.isNaN(soc) ? null : (soc / 100) * realKwh();
    real.push(r);
    simulated.push(r === null ? null : r + sim.extraEnergy[i] / 1000);
  }
  return { x, real, sim: state.capacity !== realKwh() ? simulated : undefined };
}

function nextDay(d: string): string {
  return periodRange("day", d).end;
}

// ---------------------------------------------------------------- tiles and table

function tile(label: string, unit: string, actual: number, scen: number, showDelta: boolean, dec = 0,
  goodWhenUp = true): HTMLElement {
  const delta = scen - actual;
  const children: HTMLElement[] = [
    el("div", "tile-label", label),
    el("div", "tile-value", fmt(showDelta ? scen : actual, dec), el("span", "unit", ` ${unit}`)),
  ];
  if (showDelta && Math.abs(delta) >= 10 ** -dec / 2) {
    const good = delta > 0 === goodWhenUp;
    children.push(el("div", "tile-sub",
      el("span", `delta ${good ? "good" : "bad"}`, `${delta > 0 ? "▲" : "▼"} ${delta > 0 ? "+" : ""}${fmt(delta, dec)} ${unit}`),
      el("span", "was", ` Ist ${fmt(actual, dec)} ${unit}`)));
  } else if (showDelta) {
    children.push(el("div", "tile-sub was", "unverändert"));
  }
  return el("div", "tile", ...children);
}

function tiles(total: AggRow): HTMLElement[] {
  const k = kpis(total);
  const cap = state.capacity, real = realKwh();
  const sd = cap !== real;
  let label: string, kwh: number, chf: number, chfWord: string, sub: string;
  if (cap > real) {
    [label, kwh, chf, chfWord] = [`Mehr selbst genutzt mit ${cap} kWh`, total.extra_discharged, total.saving, "gespart"];
    sub = `${fmt(total.extra_stored)} kWh Überschuss zusätzlich gespeichert`;
  } else if (sd) {
    [label, kwh, chf, chfWord] = [`Weniger selbst genutzt ${compareLabel(cap)}`, -total.extra_discharged, -total.saving,
      "Mehrkosten"];
    sub = `${fmt(-total.extra_stored)} kWh Überschuss zusätzlich eingespeist`;
  } else {
    [label, kwh, chf, chfWord] = ["Selbst genutzt aus Batterie", total.batt_to_load, total.batt_saving, "gespart"];
    sub = `Ist-Batterie (${real} kWh)`;
  }
  const hero = el("div", "tile tile-hero",
    el("div", "tile-label", label),
    el("div", "tile-value hero", fmt(kwh), el("span", "unit", " kWh")),
    el("div", "tile-sub was", sub),
    el("div", "tile-value saving", el("span", "unit", "CHF "), fmt(chf, 2), el("span", "unit", ` ${chfWord}`)));
  return [
    hero,
    tile("Produktion", "kWh", ...k.production, false),
    tile("Verbrauch", "kWh", ...k.consumption, false),
    tile("Netzbezug", "kWh", ...k.grid, sd, 0, false),
    tile("Einspeisung", "kWh", ...k.export, sd, 0, false),
    tile("Autarkie", "%", ...k.autarky, sd, 1),
    tile("Eigenverbrauch", "%", ...k.self_use, sd, 1),
    tile("Bezugskosten", "CHF", ...k.cost_import, sd, 2, false),
    tile("Einspeisevergütung", "CHF", ...k.rev_export, sd, 2),
    tile(`Stromkosten netto${total.fixed_fee > 0 ? " inkl. Grundgebühr" : ""}`, "CHF", ...k.net_cost, sd, 2, false),
  ];
}

function table(range: [number, number], fl: Flows): HTMLElement {
  const saving = state.capacity !== realKwh() ? "saving" : "batt_saving";
  const cols: [keyof AggRow, string][] = [
    ["production", "Produktion"], ["consumption", "Verbrauch"], ["grid_to_load", "Netzbezug Ist"],
    ["export", "Einspeisung Ist"], ["extra_stored", "Zus. gespeichert"], ["extra_discharged", "Netzbezug vermieden"],
    ["net_cost", "Kosten netto Ist (CHF)"], [saving, "Ersparnis (CHF)"],
  ];
  const by = state.period === "day" ? "hour" : state.period === "year" ? "month" : "day";
  const label = (key: number): string => {
    if (by === "hour") return `${pad(ds!.hour[timeRange(ds!, key, key + 1)[0]])}:00`;
    if (by === "month") return MONTHS[(key % 100) - 1];
    const d = dateOfDayKey(key);
    const dm = `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
    return state.period === "week" ? `${WEEKDAYS[weekday(d)].slice(0, 2)} ${dm}` : dm;
  };
  const head = el("tr", "", el("th", "", "Zeitraum"), ...cols.map(([, n]) => el("th", "", n)));
  const rows = aggregate(ds!, fl, range, by).map((r) =>
    el("tr", "", el("td", "", label(r.key)), ...cols.map(([c, n]) => el("td", "", fmt(r[c], n.includes("CHF") ? 2 : 1)))));
  return el("table", "data-table", el("thead", "", head), el("tbody", "", ...rows));
}

// ---------------------------------------------------------------- battery tab

let batteryFigures: {
  real: number; eff: ReturnType<typeof batteryEfficiency>; cycles: ReturnType<typeof fullCycles>;
} | null = null;

function renderBattery(): void {
  const real = realKwh();
  if (batteryFigures?.real !== real) batteryFigures = { real, eff: batteryEfficiency(ds!, real), cycles: fullCycles(ds!) };
  const t = theme();
  // Cycle starts as local time: find the interval and format its local fields
  const local = (ms: number) => localStart(timeRange(ds!, ms, ms + 1)[0]);
  plot("cycles", cycleFigure(batteryFigures.cycles, local, real, t));
  plot("efficiency", efficiencyFigure(batteryFigures.eff, t));
}

// ---------------------------------------------------------------- tariff and power inputs

function drawTariffs(): void {
  renderTariffs($("tariff"), schedule(), ds ? [firstDay, lastDay] : null, (periods) => {
    state.tariffs = periods;
    delete state.prices;
    render();
  });
}

function drawPower(): void {
  renderPowerSteps($("power-steps"), state.power ?? DEFAULT_POWER, (steps) => {
    state.power = steps;
    render();
  });
}

// ---------------------------------------------------------------- events

function applyUrl(q: URLSearchParams): void {
  const p = q.get("period");
  if (p && (PERIODS as string[]).includes(p)) state.period = p as Period;
  const d = q.get("date");
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) state.date = d;
  const size = Number(q.get("size"));
  if (q.has("size") && Number.isFinite(size)) state.capacity = Math.min(Math.max(Math.round(size), 0), 40);
  const tab = (Object.keys(TAB_PARAM) as Tab[]).find((t) => TAB_PARAM[t] === q.get("tab"));
  if (tab) state.tab = tab;
}

function onSegment(id: string, fn: (value: string) => void): void {
  $(id).addEventListener("click", (e) => {
    const value = (e.target as HTMLElement).closest("button")?.dataset.value;
    if (value) fn(value);
  });
}

function openTab(tab: Tab): void {
  state.tab = tab;
  if (tab === "data") {
    setStatus("");
    void refreshSaved();
  }
  render();
}

onSegment("tab", (v) => openTab(v as Tab));
$("to-settings").addEventListener("click", () => {
  openTab("data");
  $("settings").scrollIntoView({ behavior: "smooth", block: "start" });
});
onSegment("period", (v) => {
  state.period = v as Period;
  render();
});
for (const [id, sign] of [["prev", -1], ["next", 1]] as const) {
  $(id).addEventListener("click", () => {
    state.date = clampDate(step(state.period, state.date!, sign), firstDay, lastDay);
    render();
  });
}
$("date").addEventListener("change", (e) => {
  const v = (e.target as HTMLInputElement).value;
  if (v) {
    state.date = clampDate(v, firstDay, lastDay);
    render();
  }
});

let frame = 0;
$("capacity").addEventListener("input", (e) => {
  state.capacity = Number((e.target as HTMLInputElement).value);
  $("capacity-value").textContent = String(state.capacity);
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(render);
});

for (const [id, key] of [["real", "realKwh"], ["eff", "eff"], ["socmin", "socMin"], ["socmax", "socMax"]] as const) {
  const input = $<HTMLInputElement>(id);
  const v = state[key];
  input.value = v === null ? "" : String(v);
  input.addEventListener("change", () => {
    state[key] = input.value.trim() === "" ? null : Number(input.value);
    render();
  });
}
drawPower();

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => render());

// Data loading
$("supported-formats").textContent = `Derzeit unterstützt: ${supportedFormats()}`;
const fileInput = $<HTMLInputElement>("file-input");
fileInput.addEventListener("change", () => void fromFileList(fileInput.files).finally(() => (fileInput.value = "")));
const drop = $("dropzone");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  void fromFileList(e.dataTransfer?.files ?? null);
});
$("forget").addEventListener("click", () => void forget(null));

// Start: reopen the most recently used dataset in the last used view
drawTariffs();
showView();
(async () => {
  const [last] = await listDatasets();
  if (last) await openStored(last.id, null);
  else render();
  await refreshSaved();
})();
