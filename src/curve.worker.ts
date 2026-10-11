/**
 * Size curve in the background: simulates every battery size once per model / tariff and returns
 * the raw flow sums per local day, so the curve of any period is a cheap sum on the main thread.
 */
import { FLOW_KEYS, flows, sumFlows } from "./core/analysis";
import type { Dataset } from "./core/data";
import { type BatteryParams, batteryParams } from "./core/sim";
import type { Schedule } from "./core/tariff";

export interface CurveRequest {
  id: number;
  ds?: Dataset; // sent once (and again after new data)
  clear?: boolean; // forget the dataset
  sizes: number[];
  model: Partial<BatteryParams>;
  schedule: Schedule;
}

export interface CurveResponse {
  id: number;
  days: Int32Array; // dayKey of each day row
  /** [size][day][FLOW_KEYS] raw sums */
  sums: Float64Array;
}

let ds: Dataset | null = null;

self.onmessage = (e: MessageEvent<CurveRequest>) => {
  const req = e.data;
  if (req.clear) {
    ds = null;
    return;
  }
  if (req.ds) ds = req.ds;
  if (!ds) return;
  const k = FLOW_KEYS.length;
  let days: Int32Array | null = null;
  let sums: Float64Array | null = null;
  req.sizes.forEach((size, s) => {
    const rows = sumFlows(ds!, flows(ds!, batteryParams(size, req.model), req.schedule), [0, ds!.n], "day");
    if (!days) {
      days = Int32Array.from(rows.map((r) => r.key));
      sums = new Float64Array(req.sizes.length * rows.length * k);
    }
    rows.forEach((row, d) => {
      const base = (s * rows.length + d) * k;
      FLOW_KEYS.forEach((key, j) => (sums![base + j] = row[key]));
    });
  });
  const res: CurveResponse = { id: req.id, days: days!, sums: sums! };
  (self as unknown as Worker).postMessage(res, [res.days.buffer, res.sums.buffer]);
};
