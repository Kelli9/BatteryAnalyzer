/**
 * Tariff settings of the "Daten" view: one block per period with its dates, prices and high tariff times,
 * and a note on days that no period or several periods cover. Every edit hands the periods to `onChange`.
 */
import { DAY_TYPES, type TariffPeriod, gaps, overlaps } from "../core/tariff";
import { addDays, addMonths, formatDateCh } from "./dates";
import { TRASH_ICON, el } from "./dom";

type PriceKey = "importHt" | "importNt" | "exportHt" | "exportNt" | "feeMonth";
const PRICES: [PriceKey, string][] = [
  ["importHt", "Bezug HT (CHF/kWh)"], ["importNt", "Bezug NT (CHF/kWh)"],
  ["exportHt", "Einspeisung HT (CHF/kWh)"], ["exportNt", "Einspeisung NT (CHF/kWh)"],
  ["feeMonth", "Grundgebühr (CHF/Monat)"],
];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, "0");
const timeText = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const minutesOf = (text: string) => (/^\d{2}:\d{2}/.test(text) ? Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5)) : null);
/** At least two decimals: "0.30", "0.2825". */
const priceText = (v: number) => ((String(v).split(".")[1]?.length ?? 0) < 2 ? v.toFixed(2) : String(v));
const copy = (p: TariffPeriod): TariffPeriod => ({ ...p, ht: p.ht.map((w) => w && { ...w }) as TariffPeriod["ht"] });
const range = (a: string, b: string) => (a === b ? `am ${formatDateCh(a)}` : `vom ${formatDateCh(a)} bis ${formatDateCh(b)}`);

/** Whether stored settings are a usable list of periods. */
export function isSchedule(x: unknown): x is TariffPeriod[] {
  return Array.isArray(x) && x.length > 0 && x.every((p: TariffPeriod) => DATE.test(p?.from) && DATE.test(p?.to)
    && PRICES.every(([k]) => Number.isFinite(p[k])) && Array.isArray(p.ht) && p.ht.length === DAY_TYPES.length);
}

function input(attrs: Record<string, string | boolean>, label: string): HTMLInputElement {
  const i = document.createElement("input");
  Object.assign(i, attrs);
  i.setAttribute("aria-label", label);
  return i;
}

/** Days with no or several periods; `data`: first and last day of the loaded data (gaps only matter there). */
function issues(list: TariffPeriod[], data: [string, string] | null): HTMLElement[] {
  const out: string[] = [];
  for (const p of list) {
    if (p.from > p.to) out.push(`Periode ${formatDateCh(p.from)} – ${formatDateCh(p.to)}: «Bis» liegt vor «Von», sie gilt für keinen Tag.`);
  }
  for (const [a, b] of overlaps(list)) out.push(`Perioden überschneiden sich ${range(a, b)}: Dort gilt die später beginnende.`);
  if (data) {
    for (const [a, b] of gaps(list, ...data)) {
      out.push(`Keine Periode ${range(a, b)}: Dort gelten die Preise der nächstgelegenen.`);
    }
  }
  return out.map((text) => el("li", "", text));
}

function periodBlock(p: TariffPeriod, list: TariffPeriod[], changed: () => void, redraw: () => void): HTMLElement {
  const date = (key: "from" | "to", label: string) => {
    const i = input({ type: "date", required: true, value: p[key] }, label);
    i.addEventListener("change", () => {
      if (!DATE.test(i.value)) {
        i.value = p[key];
        return;
      }
      p[key] = i.value;
      changed();
    });
    return el("label", "", label, i);
  };
  const del = el("button", "period-del");
  Object.assign(del, { type: "button", title: "Periode löschen", disabled: list.length === 1, innerHTML: TRASH_ICON });
  del.setAttribute("aria-label", "Periode löschen");
  del.addEventListener("click", () => {
    list.splice(list.indexOf(p), 1);
    redraw();
  });

  const prices = PRICES.map(([key, label]) => {
    const i = input({ type: "number", min: "0", step: "0.01", value: priceText(p[key]) }, label);
    i.addEventListener("change", () => {
      const v = Number(i.value);
      if (i.value.trim() === "" || !Number.isFinite(v)) {
        i.value = priceText(p[key]);
        return;
      }
      p[key] = v;
      changed();
    });
    return el("label", "", label, i);
  });

  const times = DAY_TYPES.map((day, d) => {
    const w = p.ht[d];
    const from = input({ type: "time", step: "900", value: w ? timeText(w.from) : "" }, `Hochtarif ${day} von`);
    const to = input({ type: "time", step: "900", value: w ? timeText(w.to) : "" }, `Hochtarif ${day} bis`);
    const update = () => {
      const a = minutesOf(from.value), b = minutesOf(to.value);
      p.ht[d] = a === null || b === null ? null : { from: a, to: b };
      changed();
    };
    from.addEventListener("change", update);
    to.addEventListener("change", update);
    return el("div", "ht-day", el("span", "", `Hochtarif ${day}`), el("div", "ht-times", from, "–", to));
  });

  return el("div", "period",
    el("div", "period-head", date("from", "Von"), date("to", "Bis"), del),
    el("div", "period-grid", ...prices),
    el("div", "period-grid", ...times));
}

/** Draw the periods (sorted by start) into `root`. */
export function renderTariffs(root: HTMLElement, periods: TariffPeriod[], data: [string, string] | null,
  onChange: (periods: TariffPeriod[]) => void): void {
  const list = periods.map(copy).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const notes = el("ul", "tariff-issues small", ...issues(list, data));
  const changed = () => {
    onChange(list.map(copy));
    notes.replaceChildren(...issues(list, data));
  };
  const redraw = () => {
    onChange(list.map(copy));
    renderTariffs(root, list, data, onChange);
  };
  // A new period follows the one that ends last, for one year, with its prices and times
  const add = el("button", "add-btn", "+ Periode hinzufügen");
  add.setAttribute("type", "button");
  add.addEventListener("click", () => {
    const last = list.reduce((a, b) => (b.to > a.to ? b : a));
    const from = addDays(last.to, 1);
    list.push({ ...copy(last), from, to: addDays(addMonths(from, 12), -1) });
    redraw();
  });
  root.replaceChildren(...list.map((p) => periodBlock(p, list, changed, redraw)), add, notes);
}
