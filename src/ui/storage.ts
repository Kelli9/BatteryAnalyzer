/**
 * Everything stays in this browser: settings in localStorage, every loaded export file in IndexedDB.
 * Every access is guarded – storage can be blocked (private mode, site settings).
 */
import type { ExportFile } from "../core/data";

const SETTINGS_KEY = "solar-analyzer.settings.v1";
const DB_NAME = "solar-analyzer";
const DB_VERSION = 2;
const META = "meta"; // StoredDataset records (small, enough for the list)
const DATA = "data"; // file content per dataset id, only read when a dataset is opened

export function loadSettings<T>(): Partial<T> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<T>;
  } catch {
    return {};
  }
}

export function saveSettings<T>(settings: T): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: settings just aren't remembered */
  }
}

/** A stored export file: one file is one dataset. */
export interface StoredDataset {
  id: string;
  name: string;
  size: number; // bytes
  first: string; // first / last day with data, "YYYY-MM-DD"
  last: string;
  savedAt: number; // epoch ms
  usedAt: number; // last opened, epoch ms
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Version 1 kept one merged set of files under "files"; it is not carried over
      if (db.objectStoreNames.contains("files")) db.deleteObjectStore("files");
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run fn in one transaction over both stores; resolves with its request's result once committed. */
async function transaction<T>(mode: IDBTransactionMode,
  fn: (meta: IDBObjectStore, data: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction([META, DATA], mode);
      const req = fn(tx.objectStore(META), tx.objectStore(DATA));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** All stored datasets, most recently used first ([] when storage is unavailable). */
export async function listDatasets(): Promise<StoredDataset[]> {
  try {
    const all = (await transaction("readonly", (meta) => meta.getAll() as IDBRequest<StoredDataset[]>)) ?? [];
    return all.sort((a, b) => b.usedAt - a.usedAt);
  } catch {
    return [];
  }
}

/** Store a file (a stored file with the same name and size is replaced); null if that failed. */
export async function saveDataset(file: ExportFile, first: string, last: string): Promise<StoredDataset | null> {
  try {
    const size = file.data.byteLength;
    const same = (await listDatasets()).find((d) => d.name === file.name && d.size === size);
    const now = Date.now();
    const meta: StoredDataset = {
      id: same?.id ?? `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      name: file.name, size, first, last, savedAt: now, usedAt: now,
    };
    await transaction("readwrite", (m, d) => {
      m.put(meta);
      d.put(file.data, meta.id);
    });
    return meta;
  } catch {
    return null;
  }
}

/** The stored file of a dataset (null if it is gone or storage is unavailable); marks it as used. */
export async function openDataset(id: string): Promise<ExportFile | null> {
  try {
    let meta: StoredDataset | undefined;
    let data: ExportFile["data"] | undefined;
    await transaction("readwrite", (m, d) => {
      const metaReq = m.get(id) as IDBRequest<StoredDataset | undefined>;
      metaReq.onsuccess = () => {
        meta = metaReq.result;
        if (meta) m.put({ ...meta, usedAt: Date.now() });
      };
      const dataReq = d.get(id);
      dataReq.onsuccess = () => (data = dataReq.result);
    });
    return meta && data ? { name: meta.name, data } : null;
  } catch {
    return null;
  }
}

export async function deleteDataset(id: string): Promise<void> {
  try {
    await transaction("readwrite", (m, d) => {
      m.delete(id);
      d.delete(id);
    });
  } catch {
    /* nothing stored */
  }
}

export async function deleteAllDatasets(): Promise<void> {
  try {
    await transaction("readwrite", (m, d) => {
      m.clear();
      d.clear();
    });
  } catch {
    /* nothing stored */
  }
}
