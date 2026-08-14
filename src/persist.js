/**
 * Local-first save/load: JSON download, last-project localStorage,
 * IndexedDB helpers for GLB ArrayBuffers (used in a later phase).
 */

import { clone, normalizeLoadedProject } from "./model.js";

export const LAST_PROJECT_KEY = "ortho-apartment-builder-v1";
export const IDB_NAME = "ortho-apartment-builder";
export const IDB_VERSION = 1;
export const IDB_STORE = "glb-blobs";

function suggestedFilename(doc) {
  const raw = doc?.project?.name || "apartment";
  const name = String(raw).trim().replace(/[^\w\-]+/g, "_") || "apartment";
  return `${name}.json`;
}

export function serializeProject(doc) {
  return JSON.stringify(clone(doc), null, 2);
}

export function parseProjectJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }
  return normalizeLoadedProject(raw);
}

/** Trigger a JSON file download of the project document. */
export function downloadProject(doc, filename) {
  const name = filename || suggestedFilename(doc);
  const blob = new Blob([serializeProject(doc)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

/** @param {File | Blob} file */
export async function loadProjectFile(file) {
  const text = await file.text();
  return parseProjectJson(text);
}

/**
 * Open a file picker and resolve the loaded project, or null if cancelled.
 * @returns {Promise<object | null>}
 */
export function promptLoadProject() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("cancel", () => resolve(null));
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        resolve(await loadProjectFile(file));
      } catch (err) {
        reject(err);
      }
    });
    input.click();
  });
}

export function saveLastProject(doc) {
  if (typeof localStorage === "undefined") {
    throw new Error("localStorage is not available");
  }
  localStorage.setItem(LAST_PROJECT_KEY, serializeProject(doc));
}

/** @returns {object | null} */
export function loadLastProject() {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(LAST_PROJECT_KEY);
  if (!raw) return null;
  return parseProjectJson(raw);
}

export function clearLastProject() {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LAST_PROJECT_KEY);
}

function idbAvailable() {
  return typeof indexedDB !== "undefined";
}

function openAssetDb() {
  if (!idbAvailable()) {
    return Promise.reject(new Error("IndexedDB is not available"));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB"));
  });
}

function withStore(mode, fn) {
  return openAssetDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err, value) => {
          if (settled) return;
          settled = true;
          db.close();
          if (err) reject(err);
          else resolve(value);
        };
        const tx = db.transaction(IDB_STORE, mode);
        const store = tx.objectStore(IDB_STORE);
        let requestResult;
        try {
          const maybeReq = fn(store);
          if (maybeReq && typeof maybeReq === "object" && "onsuccess" in maybeReq) {
            maybeReq.onsuccess = () => {
              requestResult = maybeReq.result;
            };
            maybeReq.onerror = () => finish(maybeReq.error);
          }
        } catch (err) {
          finish(err);
          return;
        }
        tx.oncomplete = () => finish(null, requestResult);
        tx.onerror = () => finish(tx.error || new Error("IndexedDB transaction failed"));
        tx.onabort = () => finish(tx.error || new Error("IndexedDB transaction aborted"));
      }),
  );
}

/**
 * Store a GLB/glTF payload. Record shape: `{ id, buffer }` (ArrayBuffer).
 * @param {string} id
 * @param {ArrayBuffer} buffer
 */
export async function putAssetBlob(id, buffer) {
  if (!id) throw new Error("putAssetBlob requires an id");
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error("putAssetBlob requires an ArrayBuffer");
  }
  await withStore("readwrite", (store) => store.put({ id, buffer }));
  return id;
}

/** @returns {Promise<ArrayBuffer | null>} */
export async function getAssetBlob(id) {
  const rec = await withStore("readonly", (store) => store.get(id));
  return rec?.buffer ?? null;
}

export async function deleteAssetBlob(id) {
  await withStore("readwrite", (store) => store.delete(id));
}

/** @returns {Promise<string[]>} */
export async function listAssetBlobIds() {
  const ids = await withStore("readonly", (store) => store.getAllKeys());
  return Array.from(ids || []);
}

export async function clearAssetBlobs() {
  await withStore("readwrite", (store) => store.clear());
}

export const assetBlobs = {
  put: putAssetBlob,
  get: getAssetBlob,
  delete: deleteAssetBlob,
  list: listAssetBlobIds,
  clear: clearAssetBlobs,
};

export { openAssetDb };
