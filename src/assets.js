/**
 * Furniture catalog layer.
 *
 * v1 ships PrimitiveProvider (procedural boxes) and LocalGltfProvider
 * (user-imported GLB/glTF into IndexedDB). A future partner catalog
 * (e.g. IKEA after a legal deal) implements the same CatalogProvider
 * interface — not a new app.
 *
 * Do not call unofficial retailer scrape endpoints.
 */

import { uid } from "./model.js";
import { deleteAssetBlob, getAssetBlob, putAssetBlob } from "./persist.js";

/**
 * CatalogProvider
 *
 * @typedef {object} CatalogItem
 * @property {string} id
 * @property {string} label
 * @property {number} w width (m)
 * @property {number} d depth (m)
 * @property {number} h height (m)
 * @property {"primitive" | "glb"} kind
 * @property {string} [src] blob key / url for glb items
 * @property {string} [color] default hex color for primitives
 *
 * @typedef {object} CatalogProvider
 * @property {string} id
 * @property {(q: string) => Promise<CatalogItem[]>} search
 * @property {(itemId: string) => Promise<ArrayBuffer>} loadGltf
 */

/** Typical real-world sizes, meters. */
export const PRIMITIVES = Object.freeze([
  Object.freeze({
    id: "prim_sofa",
    kind: "primitive",
    label: "Sofa",
    w: 2.0,
    d: 0.9,
    h: 0.85,
    color: "#6b736c",
  }),
  Object.freeze({
    id: "prim_table4",
    kind: "primitive",
    label: "Table 4p",
    w: 1.2,
    d: 0.8,
    h: 0.75,
    color: "#8b6914",
  }),
  Object.freeze({
    id: "prim_chair",
    kind: "primitive",
    label: "Chair",
    w: 0.45,
    d: 0.5,
    h: 0.9,
    color: "#5c5346",
  }),
  Object.freeze({
    id: "prim_tv_bench",
    kind: "primitive",
    label: "TV bench",
    w: 1.6,
    d: 0.4,
    h: 0.45,
    color: "#2a2e2c",
  }),
  Object.freeze({
    id: "prim_box",
    kind: "primitive",
    label: "Box",
    w: 0.6,
    d: 0.6,
    h: 0.6,
    color: "#7a8f84",
  }),
  Object.freeze({
    id: "prim_bed",
    kind: "primitive",
    label: "Bed",
    w: 1.6,
    d: 2.0,
    h: 0.5,
    color: "#8a8178",
  }),
  Object.freeze({
    id: "prim_kitchen_counter",
    kind: "primitive",
    label: "Kitchen counter",
    w: 2.0,
    d: 0.6,
    h: 0.9,
    color: "#c4b8a8",
  }),
]);

function matchesQuery(item, q) {
  const s = (q || "").trim().toLowerCase();
  if (!s) return true;
  return (
    item.label.toLowerCase().includes(s) ||
    item.id.toLowerCase().includes(s) ||
    item.kind.toLowerCase().includes(s)
  );
}

export class PrimitiveProvider {
  constructor() {
    this.id = "primitives";
  }

  /** @returns {CatalogItem[]} */
  list() {
    return PRIMITIVES.map((item) => ({ ...item }));
  }

  /** @param {string} itemId */
  get(itemId) {
    const item = PRIMITIVES.find((p) => p.id === itemId);
    return item ? { ...item } : null;
  }

  /**
   * @param {string} q
   * @returns {Promise<CatalogItem[]>}
   */
  async search(q) {
    return this.list().filter((item) => matchesQuery(item, q));
  }

  /**
   * Primitives are boxes, not glTF.
   * @param {string} _itemId
   * @returns {Promise<ArrayBuffer>}
   */
  async loadGltf(_itemId) {
    throw new Error("PrimitiveProvider has no glTF; mesh from w/d/h in the catalog item");
  }
}

function labelFromFilename(name) {
  const base = String(name || "Import")
    .replace(/\.(glb|gltf)$/i, "")
    .replace(/[_\-]+/g, " ")
    .trim();
  return base || "Imported GLB";
}

/**
 * Measure an ArrayBuffer GLB/glTF with Three.js GLTFLoader when available.
 * Falls back to a 1×1×1 m box if Three is not loaded yet.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{ w: number, d: number, h: number }>}
 */
async function measureGltfBuffer(buffer) {
  const fallback = { w: 1, d: 1, h: 1 };
  try {
    const THREE = await import("three");
    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      loader.parse(buffer.slice(0), "", resolve, reject);
    });
    const root = gltf.scene || gltf.scenes?.[0];
    if (!root) return fallback;
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const w = size.x > 1e-4 ? size.x : fallback.w;
    const h = size.y > 1e-4 ? size.y : fallback.h;
    const d = size.z > 1e-4 ? size.z : fallback.d;
    return {
      w: Math.round(w * 1000) / 1000,
      d: Math.round(d * 1000) / 1000,
      h: Math.round(h * 1000) / 1000,
    };
  } catch {
    return fallback;
  }
}

/**
 * Local user-imported GLB/glTF catalog.
 * Blobs live in IndexedDB; JSON project stores `{ id, kind:'glb', …, src: id }`.
 */
export class LocalGltfProvider {
  constructor() {
    this.id = "local-gltf";
    /** @type {CatalogItem[]} */
    this.items = [];
  }

  /** @returns {CatalogItem[]} */
  list() {
    return this.items.map((item) => ({ ...item }));
  }

  /** @param {string} itemId */
  get(itemId) {
    const item = this.items.find((p) => p.id === itemId);
    return item ? { ...item } : null;
  }

  /**
   * @param {string} q
   * @returns {Promise<CatalogItem[]>}
   */
  async search(q) {
    return this.list().filter((item) => matchesQuery(item, q));
  }

  /**
   * @param {string} itemId
   * @returns {Promise<ArrayBuffer>}
   */
  async loadGltf(itemId) {
    const item = this.get(itemId);
    const key = item?.src || itemId;
    const buffer = await getAssetBlob(key);
    if (!buffer) throw new Error(`No GLB blob in IndexedDB for: ${key}`);
    return buffer;
  }

  /**
   * Import a local .glb / .gltf file into IndexedDB and this provider's list.
   * Returns an asset descriptor suitable for `cmdAddAsset`.
   * @param {File | Blob} file
   * @param {{ id?: string, label?: string }} [opts]
   * @returns {Promise<CatalogItem>}
   */
  async importFile(file, opts = {}) {
    if (!file) throw new Error("importFile requires a File or Blob");
    const name = file.name || opts.label || "import.glb";
    const lower = name.toLowerCase();
    if (!lower.endsWith(".glb") && !lower.endsWith(".gltf") && file.type && !/gltf|glb/i.test(file.type)) {
      throw new Error("Expected a .glb or .gltf file");
    }

    const buffer = await file.arrayBuffer();
    const id = opts.id || uid("asset");
    const size = await measureGltfBuffer(buffer);
    await putAssetBlob(id, buffer);

    /** @type {CatalogItem} */
    const asset = {
      id,
      kind: "glb",
      label: opts.label || labelFromFilename(name),
      w: size.w,
      d: size.d,
      h: size.h,
      src: id,
    };

    const existing = this.items.findIndex((i) => i.id === id);
    if (existing >= 0) this.items[existing] = asset;
    else this.items.push(asset);
    return { ...asset };
  }

  /**
   * Remove a catalog entry and its IndexedDB blob (does not touch session.doc).
   * @param {string} itemId
   */
  async remove(itemId) {
    const item = this.get(itemId);
    this.items = this.items.filter((i) => i.id !== itemId);
    const key = item?.src || itemId;
    try {
      await deleteAssetBlob(key);
    } catch {
      // Blob may already be gone.
    }
  }

  /**
   * Rehydrate provider list from project `assets[]` (GLB entries only).
   * Does not reload blobs — they stay in IndexedDB keyed by `src` / `id`.
   * @param {object[]} assets
   */
  syncFromDocAssets(assets) {
    this.items = (assets || [])
      .filter((a) => a && a.kind === "glb")
      .map((a) => ({
        id: a.id,
        kind: "glb",
        label: a.label || "GLB",
        w: a.w ?? 1,
        d: a.d ?? 1,
        h: a.h ?? 1,
        src: a.src || a.id,
      }));
  }
}

export const primitiveProvider = new PrimitiveProvider();
export const localGltfProvider = new LocalGltfProvider();
export const providers = [primitiveProvider, localGltfProvider];
