/**
 * Power settings of the "Daten" view: one row per step of the total battery size with the max. charge and
 * discharge power from that size on, and a note on steps with the same start. Every edit hands the steps
 * to `onChange`.
 */
import type { PowerStep } from "../core/sim";
import { TRASH_ICON, el } from "./dom";

const COLUMNS: [key: keyof PowerStep, label: string, step: string][] = [
  ["fromKwh", "Ab Gesamtgrösse (kWh)", "1"], ["chargeKw", "Laden (kW)", "0.1"], ["dischargeKw", "Entladen (kW)", "0.1"],
];

const byStart = (a: PowerStep, b: PowerStep) => a.fromKwh - b.fromKwh;

/** Whether stored settings are a usable list of steps. */
export function isPowerSteps(x: unknown): x is PowerStep[] {
  return Array.isArray(x) && x.length > 0
    && x.every((s: PowerStep) => COLUMNS.every(([k]) => Number.isFinite(s?.[k]) && s[k] >= 0));
}

/** Starts that several steps share. */
function issues(list: PowerStep[]): HTMLElement[] {
  const starts = list.map((s) => s.fromKwh);
  const shared = [...new Set(starts.filter((v, i) => starts.indexOf(v) !== i))].sort((a, b) => a - b);
  return shared.map((v) => el("li", "", `Mehrere Stufen ab ${v} kWh: Es gilt die letzte davon in der Liste.`));
}

/** Inputs and delete button of one step (n: its number in the list). */
function row(s: PowerStep, n: number, list: PowerStep[], changed: () => void, redraw: () => void): HTMLElement[] {
  const inputs = COLUMNS.map(([key, label, step]) => {
    const i = document.createElement("input");
    Object.assign(i, { type: "number", min: "0", step, value: String(s[key]) });
    i.setAttribute("aria-label", `${label}, Stufe ${n}`);
    i.addEventListener("change", () => {
      const v = Number(i.value);
      if (i.value.trim() === "" || !Number.isFinite(v) || v < 0) {
        i.value = String(s[key]);
        return;
      }
      s[key] = v;
      changed();
    });
    return i;
  });
  const del = el("button", "step-del");
  Object.assign(del, { type: "button", title: "Stufe löschen", disabled: list.length === 1, innerHTML: TRASH_ICON });
  del.setAttribute("aria-label", `Stufe ${n} löschen`);
  del.addEventListener("click", () => {
    list.splice(list.indexOf(s), 1);
    redraw();
  });
  return [...inputs, del];
}

/** Draw the steps (sorted by start) into `root`. */
export function renderPowerSteps(root: HTMLElement, steps: PowerStep[], onChange: (steps: PowerStep[]) => void): void {
  const list = steps.map((s) => ({ ...s })).sort(byStart);
  const notes = el("ul", "power-issues small", ...issues(list));
  const changed = () => {
    onChange(list.map((s) => ({ ...s })));
    notes.replaceChildren(...issues(list));
  };
  const redraw = () => {
    onChange(list.map((s) => ({ ...s })));
    renderPowerSteps(root, list, onChange);
  };
  // A new step starts 5 kWh above the highest one, with its power
  const add = el("button", "add-btn", "+ Stufe hinzufügen");
  add.setAttribute("type", "button");
  add.addEventListener("click", () => {
    const top = list.reduce((a, b) => (b.fromKwh >= a.fromKwh ? b : a));
    list.push({ ...top, fromKwh: top.fromKwh + 5 });
    redraw();
  });
  const grid = el("div", "power-grid", ...COLUMNS.map(([, label]) => el("span", "", label)), el("span"),
    ...list.flatMap((s, i) => row(s, i + 1, list, changed, redraw)));
  root.replaceChildren(grid, add, notes);
}
