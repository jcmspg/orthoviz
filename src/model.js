/**
 * Orthogonal apartment builder — document model, geometry helpers, command/undo.
 * Schema is generic (blank project), product-agnostic.
 */

export const SCHEMA_VERSION = 1;
export const GRID = 0.1;
export const UNDO_LIMIT = 250;

export const WALL_DEFAULTS = Object.freeze({
  thicknessInterior: 0.1,
  thicknessExterior: 0.25,
  height: 2.6,
});

export const DEFAULT_LEVEL_ID = "level_ground";
export const DEFAULT_MAT_WALL_ID = "mat_wall";
export const DEFAULT_MAT_FLOOR_ID = "mat_floor";

export const OPENING_DEFAULTS = Object.freeze({
  door: Object.freeze({ width: 0.8, height: 2.1, sill: 0 }),
  window: Object.freeze({ width: 1.2, height: 1.2, sill: 0.9 }),
});

export const CMD = Object.freeze({
  ADD_WALL: "addWall",
  MOVE_WALL: "moveWall",
  DELETE_WALL: "deleteWall",
  UPDATE_WALL: "updateWall",
  ADD_OPENING: "addOpening",
  MOVE_OPENING: "moveOpening",
  DELETE_OPENING: "deleteOpening",
  UPDATE_OPENING: "updateOpening",
  ADD_FLOOR: "addFloor",
  MOVE_FLOOR: "moveFloor",
  DELETE_FLOOR: "deleteFloor",
  UPDATE_FLOOR: "updateFloor",
  ADD_STAIR: "addStair",
  MOVE_STAIR: "moveStair",
  DELETE_STAIR: "deleteStair",
  UPDATE_STAIR: "updateStair",
  ADD_FURNITURE: "addFurniture",
  MOVE_FURNITURE: "moveFurniture",
  DELETE_FURNITURE: "deleteFurniture",
  UPDATE_FURNITURE: "updateFurniture",
  ADD_MATERIAL: "addMaterial",
  UPDATE_MATERIAL: "updateMaterial",
  DELETE_MATERIAL: "deleteMaterial",
  ADD_ASSET: "addAsset",
  UPDATE_ASSET: "updateAsset",
  DELETE_ASSET: "deleteAsset",
  UPDATE_PROJECT: "updateProject",
});

const EPS = 1e-9;
const MM = 1000;

let seq = 0;

/** @param {string} [prefix] */
export function uid(prefix = "id") {
  seq += 1;
  return `${prefix}_${seq}`;
}

export function peekUidSeq() {
  return seq;
}

/**
 * Raise the module id counter so new uids do not collide with `doc`.
 * @param {object} doc
 */
export function syncUidCounter(doc) {
  let max = 0;
  forEachId(doc, (id) => {
    const m = String(id).match(/_(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  if (max > seq) seq = max;
}

function forEachId(doc, fn) {
  if (!doc) return;
  for (const level of doc.levels || []) fn(level.id);
  for (const wall of doc.walls || []) {
    fn(wall.id);
    for (const opening of wall.openings || []) fn(opening.id);
  }
  for (const key of ["floors", "stairs", "furniture", "materials", "assets"]) {
    for (const item of doc[key] || []) fn(item.id);
  }
}

export function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/** @param {number} value @param {number} [grid] */
export function snapToGrid(value, grid = GRID) {
  const g = grid > 0 ? grid : GRID;
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.round(value / g) * g * MM) / MM;
}

/** @param {number} x @param {number} y @param {number} [grid] */
export function snapPoint(x, y, grid = GRID) {
  return { x: snapToGrid(x, grid), y: snapToGrid(y, grid) };
}

/** Force a segment onto X or Y (dominant axis; ties go horizontal). */
export function clampOrtho(x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  if (dy > dx) return { x0, y0, x1: x0, y1 };
  return { x0, y0, x1, y1: y0 };
}

/** Snap both ends then clamp to axis-aligned. */
export function orthoSegment(x0, y0, x1, y1, grid = GRID) {
  const a = snapPoint(x0, y0, grid);
  const b = snapPoint(x1, y1, grid);
  const seg = clampOrtho(a.x, a.y, b.x, b.y);
  return {
    x0: snapToGrid(seg.x0, grid),
    y0: snapToGrid(seg.y0, grid),
    x1: snapToGrid(seg.x1, grid),
    y1: snapToGrid(seg.y1, grid),
  };
}

export function wallLength(wall) {
  return Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0);
}

export function isHorizontal(wall, eps = EPS) {
  return Math.abs(wall.y1 - wall.y0) < eps;
}

export function isVertical(wall, eps = EPS) {
  return Math.abs(wall.x1 - wall.x0) < eps;
}

export function isAxisAligned(wall, eps = EPS) {
  return isHorizontal(wall, eps) || isVertical(wall, eps);
}

export function wallDirection(wall) {
  const len = wallLength(wall);
  if (len < EPS) return { ux: 0, uy: 0, len: 0 };
  return { ux: (wall.x1 - wall.x0) / len, uy: (wall.y1 - wall.y0) / len, len };
}

export function pointAtAlong(wall, along) {
  const { ux, uy } = wallDirection(wall);
  return { x: wall.x0 + ux * along, y: wall.y0 + uy * along };
}

export function alongAtPoint(wall, x, y) {
  const { ux, uy, len } = wallDirection(wall);
  if (len < EPS) return 0;
  const along = (x - wall.x0) * ux + (y - wall.y0) * uy;
  return Math.max(0, Math.min(len, along));
}

function gridOf(doc) {
  const g = doc?.project?.grid;
  return g > 0 ? g : GRID;
}

function defaultsOf(doc) {
  return doc?.project?.wallDefaults || WALL_DEFAULTS;
}

/**
 * @param {{ name?: string, grid?: number, levelName?: string }} [options]
 */
export function createBlankProject(options = {}) {
  const grid = options.grid ?? GRID;
  const doc = {
    version: SCHEMA_VERSION,
    project: {
      name: options.name ?? "Untitled",
      units: "m",
      grid,
      wallDefaults: {
        thicknessInterior: WALL_DEFAULTS.thicknessInterior,
        thicknessExterior: WALL_DEFAULTS.thicknessExterior,
        height: WALL_DEFAULTS.height,
      },
    },
    levels: [
      {
        id: DEFAULT_LEVEL_ID,
        name: options.levelName ?? "Level 1",
        z: 0,
      },
    ],
    walls: [],
    floors: [],
    stairs: [],
    furniture: [],
    materials: [
      { id: DEFAULT_MAT_WALL_ID, color: "#d7d2c8" },
      { id: DEFAULT_MAT_FLOOR_ID, color: "#2e3631" },
    ],
    assets: [],
  };
  syncUidCounter(doc);
  return doc;
}

/**
 * @param {object} doc
 * @returns {object} the same doc if valid
 */
export function validateProject(doc) {
  if (!doc || typeof doc !== "object") throw new Error("Invalid project: not an object");
  if (doc.version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported project version: ${doc.version} (expected ${SCHEMA_VERSION})`);
  }
  if (!doc.project || typeof doc.project !== "object") {
    throw new Error("Invalid project: missing project meta");
  }
  if (doc.project.units && doc.project.units !== "m") {
    throw new Error(`Unsupported units: ${doc.project.units} (expected m)`);
  }
  for (const key of ["levels", "walls", "floors", "stairs", "furniture", "materials", "assets"]) {
    if (!Array.isArray(doc[key])) throw new Error(`Invalid project: missing array "${key}"`);
  }
  if (!doc.levels.length) throw new Error("Invalid project: need at least one level");
  return doc;
}

/**
 * Clone, validate, ensure nested arrays, sync uid counter. Used on load.
 * @param {object} raw
 */
export function normalizeLoadedProject(raw) {
  const doc = clone(raw);
  validateProject(doc);
  if (!Number.isFinite(doc.project.grid) || doc.project.grid <= 0) doc.project.grid = GRID;
  if (!doc.project.wallDefaults) {
    doc.project.wallDefaults = { ...WALL_DEFAULTS };
  }
  for (const wall of doc.walls) {
    if (!Array.isArray(wall.openings)) wall.openings = [];
  }
  syncUidCounter(doc);
  return doc;
}

export function createSession(doc) {
  return {
    doc: normalizeLoadedProject(doc ?? createBlankProject()),
    undoStack: [],
    redoStack: [],
  };
}

export function resetSession(session, doc) {
  session.doc = normalizeLoadedProject(doc);
  session.undoStack = [];
  session.redoStack = [];
  return session;
}

export function canUndo(session) {
  return (session?.undoStack?.length ?? 0) > 0;
}

export function canRedo(session) {
  return (session?.redoStack?.length ?? 0) > 0;
}

export function getLevel(doc, id) {
  return doc.levels.find((l) => l.id === id) || null;
}

export function getDefaultLevel(doc) {
  return doc.levels[0] || null;
}

export function getWall(doc, id) {
  return doc.walls.find((w) => w.id === id) || null;
}

/** @returns {{ wall: object, opening: object } | null} */
export function getOpening(doc, openingId) {
  for (const wall of doc.walls) {
    const opening = (wall.openings || []).find((o) => o.id === openingId);
    if (opening) return { wall, opening };
  }
  return null;
}

export function getFloor(doc, id) {
  return doc.floors.find((f) => f.id === id) || null;
}

export function getStair(doc, id) {
  return doc.stairs.find((s) => s.id === id) || null;
}

export function getFurniture(doc, id) {
  return doc.furniture.find((f) => f.id === id) || null;
}

export function getMaterial(doc, id) {
  return doc.materials.find((m) => m.id === id) || null;
}

export function getAsset(doc, id) {
  return doc.assets.find((a) => a.id === id) || null;
}

export function listOpenings(doc) {
  const out = [];
  for (const wall of doc.walls) {
    for (const opening of wall.openings || []) {
      out.push({ wallId: wall.id, opening });
    }
  }
  return out;
}

export function getProjectGrid(doc) {
  return gridOf(doc);
}

/** Bounding box of walls, floors, stairs, furniture (plan extents). */
export function extents(doc) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  const acc = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    any = true;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const w of doc.walls) {
    acc(w.x0, w.y0);
    acc(w.x1, w.y1);
  }
  for (const f of doc.floors) {
    acc(f.x, f.y);
    acc(f.x + f.w, f.y + f.d);
  }
  for (const s of doc.stairs) {
    acc(s.x, s.y);
    acc(s.x + s.w, s.y + s.d);
  }
  for (const f of doc.furniture) acc(f.x, f.y);
  if (!any) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, depth: 0 };
  return { minX, minY, maxX, maxY, width: maxX - minX, depth: maxY - minY };
}

export const getters = {
  getLevel,
  getDefaultLevel,
  getWall,
  getOpening,
  getFloor,
  getStair,
  getFurniture,
  getMaterial,
  getAsset,
  listOpenings,
  getProjectGrid,
  extents,
};

function requireWall(doc, id) {
  const wall = getWall(doc, id);
  if (!wall) throw new Error(`Wall not found: ${id}`);
  return wall;
}

function takeEntity(payload, key) {
  if (payload[key] && typeof payload[key] === "object") return { ...payload[key] };
  const copy = { ...payload };
  delete copy.index;
  return copy;
}

function insertAt(list, item, index) {
  if (Number.isInteger(index) && index >= 0 && index <= list.length) {
    list.splice(index, 0, item);
  } else {
    list.push(item);
  }
}

function clampOpening(wall, opening, grid) {
  const len = wallLength(wall);
  const width = Math.max(grid, snapToGrid(opening.width, grid));
  const along = snapToGrid(opening.along ?? 0, grid);
  const maxAlong = Math.max(0, snapToGrid(len - width, grid));
  return {
    ...opening,
    width: Math.min(width, Math.max(grid, snapToGrid(len, grid)) || width),
    along: Math.max(0, Math.min(along, maxAlong)),
  };
}

function within(a, b, c, tol = EPS) {
  return c >= Math.min(a, b) - tol && c <= Math.max(a, b) + tol;
}

function snapWallToCorners(doc, wall) {
  const g = gridOf(doc);
  const tol = Math.max(g * 0.75, 0.08);
  const horizontal = isHorizontal(wall);
  const vertical = !horizontal;
  const others = (doc.walls || []).filter((w) => w.id !== wall.id);
  const endpoints = [
    { x: wall.x0, y: wall.y0 },
    { x: wall.x1, y: wall.y1 },
  ];

  const snapOne = (point) => {
    let best = null;
    for (const other of others) {
      const candidates = [
        { x: other.x0, y: other.y0 },
        { x: other.x1, y: other.y1 },
      ];
      if (horizontal && isVertical(other) && within(other.y0, other.y1, point.y, tol)) {
        candidates.push({ x: other.x0, y: point.y });
      } else if (vertical && isHorizontal(other) && within(other.x0, other.x1, point.x, tol)) {
        candidates.push({ x: point.x, y: other.y0 });
      }
      for (const c of candidates) {
        const d = Math.hypot(point.x - c.x, point.y - c.y);
        if (d <= tol && (!best || d < best.dist)) {
          best = { x: c.x, y: c.y, dist: d };
        }
      }
    }
    if (!best) return point;
    return snapPoint(best.x, best.y, g);
  };

  const a = snapOne(endpoints[0]);
  const b = snapOne(endpoints[1]);
  if (horizontal) {
    const y = snapToGrid((a.y + b.y) * 0.5, g);
    return orthoSegment(a.x, y, b.x, y, g);
  }
  const x = snapToGrid((a.x + b.x) * 0.5, g);
  return orthoSegment(x, a.y, x, b.y, g);
}

function normalizeWall(doc, payload) {
  const d = defaultsOf(doc);
  const grid = gridOf(doc);
  const raw = takeEntity(payload, "wall");
  const seg = orthoSegment(raw.x0, raw.y0, raw.x1, raw.y1, grid);
  const wall = {
    id: raw.id || uid("wall"),
    x0: seg.x0,
    y0: seg.y0,
    x1: seg.x1,
    y1: seg.y1,
    thickness: snapToGrid(raw.thickness ?? d.thicknessInterior, grid),
    height: raw.height ?? d.height,
    materialId: raw.materialId ?? DEFAULT_MAT_WALL_ID,
    openings: Array.isArray(raw.openings) ? clone(raw.openings) : [],
  };
  const snapped = snapWallToCorners(doc, wall);
  wall.x0 = snapped.x0;
  wall.y0 = snapped.y0;
  wall.x1 = snapped.x1;
  wall.y1 = snapped.y1;
  if (raw.levelId) wall.levelId = raw.levelId;
  if (raw.label) wall.label = raw.label;
  if (wallLength(wall) < EPS) throw new Error("Wall length is zero after ortho snap");
  return wall;
}

function stamp(payload, key, entity) {
  payload[key] = clone(entity);
  return entity;
}

function normalizeOpening(doc, wall, payload) {
  const grid = gridOf(doc);
  const raw = takeEntity(payload, "opening");
  const type = raw.type === "window" ? "window" : "door";
  const fallback = OPENING_DEFAULTS[type];
  const opening = clampOpening(wall, {
    id: raw.id || uid(type),
    type,
    along: raw.along ?? 0,
    width: raw.width ?? fallback.width,
    height: raw.height ?? fallback.height,
    sill: raw.sill ?? fallback.sill,
  }, grid);
  return opening;
}

function normalizeFloor(doc, payload) {
  const grid = gridOf(doc);
  const raw = takeEntity(payload, "floor");
  return {
    id: raw.id || uid("floor"),
    x: snapToGrid(raw.x ?? 0, grid),
    y: snapToGrid(raw.y ?? 0, grid),
    w: Math.max(grid, snapToGrid(raw.w ?? 1, grid)),
    d: Math.max(grid, snapToGrid(raw.d ?? 1, grid)),
    materialId: raw.materialId ?? DEFAULT_MAT_FLOOR_ID,
  };
}

function normalizeStair(doc, payload) {
  const grid = gridOf(doc);
  const d = defaultsOf(doc);
  const raw = takeEntity(payload, "stair");
  return {
    id: raw.id || uid("stair"),
    x: snapToGrid(raw.x ?? 0, grid),
    y: snapToGrid(raw.y ?? 0, grid),
    w: Math.max(grid, snapToGrid(raw.w ?? 1, grid)),
    d: Math.max(grid, snapToGrid(raw.d ?? 0.9, grid)),
    height: raw.height ?? d.height,
    steps: Math.max(1, Math.round(raw.steps ?? 12)),
  };
}

function normalizeFurniture(doc, payload) {
  const grid = gridOf(doc);
  const raw = takeEntity(payload, "furniture");
  if (!raw.assetId) throw new Error("Furniture requires assetId");
  return {
    id: raw.id || uid("furn"),
    assetId: raw.assetId,
    x: snapToGrid(raw.x ?? 0, grid),
    y: snapToGrid(raw.y ?? 0, grid),
    rot: raw.rot ?? 0,
    sx: raw.sx ?? 1,
    sy: raw.sy ?? 1,
    sz: raw.sz ?? 1,
  };
}

function normalizeMaterial(payload) {
  const raw = takeEntity(payload, "material");
  const material = {
    id: raw.id || uid("mat"),
    color: raw.color ?? "#cccccc",
  };
  if (raw.textureUrl) material.textureUrl = raw.textureUrl;
  return material;
}

function normalizeAsset(payload) {
  const raw = takeEntity(payload, "asset");
  const kind = raw.kind === "glb" ? "glb" : "primitive";
  const asset = {
    id: raw.id || uid("asset"),
    kind,
    label: raw.label ?? "Asset",
    w: raw.w ?? 1,
    d: raw.d ?? 1,
    h: raw.h ?? 1,
  };
  if (raw.src) asset.src = raw.src;
  return asset;
}

function applyAddWall(doc, payload) {
  const wall = normalizeWall(doc, payload);
  if (getWall(doc, wall.id)) throw new Error(`Wall already exists: ${wall.id}`);
  insertAt(doc.walls, wall, payload.index);
  stamp(payload, "wall", wall);
  return { type: CMD.DELETE_WALL, payload: { id: wall.id } };
}

function applyMoveWall(doc, payload) {
  const wall = requireWall(doc, payload.id);
  const grid = gridOf(doc);
  const prev = { x0: wall.x0, y0: wall.y0, x1: wall.x1, y1: wall.y1 };
  let next;
  if (payload.x0 !== undefined || payload.x1 !== undefined || payload.y0 !== undefined || payload.y1 !== undefined) {
    next = orthoSegment(
      payload.x0 ?? wall.x0,
      payload.y0 ?? wall.y0,
      payload.x1 ?? wall.x1,
      payload.y1 ?? wall.y1,
      grid,
    );
  } else {
    const dx = payload.dx ?? 0;
    const dy = payload.dy ?? 0;
    next = orthoSegment(wall.x0 + dx, wall.y0 + dy, wall.x1 + dx, wall.y1 + dy, grid);
  }
  if (Math.hypot(next.x1 - next.x0, next.y1 - next.y0) < EPS) {
    throw new Error("Wall length is zero after move");
  }
  Object.assign(wall, next);
  Object.assign(wall, snapWallToCorners(doc, wall));
  for (const opening of wall.openings || []) {
    Object.assign(opening, clampOpening(wall, opening, grid));
  }
  return { type: CMD.MOVE_WALL, payload: { id: wall.id, ...prev } };
}

function applyDeleteWall(doc, payload) {
  const index = doc.walls.findIndex((w) => w.id === payload.id);
  if (index < 0) throw new Error(`Wall not found: ${payload.id}`);
  const [wall] = doc.walls.splice(index, 1);
  return { type: CMD.ADD_WALL, payload: { wall: clone(wall), index } };
}

function applyUpdateWall(doc, payload) {
  const wall = requireWall(doc, payload.id);
  const grid = gridOf(doc);
  const patch = payload.patch || {};
  const prev = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id" || key === "openings") continue;
    prev[key] = clone(wall[key]);
    if (key === "thickness") wall[key] = snapToGrid(value, grid);
    else wall[key] = clone(value);
  }
  if (["x0", "y0", "x1", "y1"].some((k) => patch[k] !== undefined)) {
    Object.assign(wall, orthoSegment(wall.x0, wall.y0, wall.x1, wall.y1, grid));
    Object.assign(wall, snapWallToCorners(doc, wall));
    for (const opening of wall.openings || []) {
      Object.assign(opening, clampOpening(wall, opening, grid));
    }
  }
  return { type: CMD.UPDATE_WALL, payload: { id: wall.id, patch: prev } };
}

function applyAddOpening(doc, payload) {
  const wall = requireWall(doc, payload.wallId);
  if (!Array.isArray(wall.openings)) wall.openings = [];
  const opening = normalizeOpening(doc, wall, payload);
  if (wall.openings.some((o) => o.id === opening.id)) {
    throw new Error(`Opening already exists: ${opening.id}`);
  }
  insertAt(wall.openings, opening, payload.index);
  stamp(payload, "opening", opening);
  return { type: CMD.DELETE_OPENING, payload: { id: opening.id } };
}

function applyMoveOpening(doc, payload) {
  const found = getOpening(doc, payload.id);
  if (!found) throw new Error(`Opening not found: ${payload.id}`);
  const grid = gridOf(doc);
  const prevAlong = found.opening.along;
  const prevWidth = found.opening.width;
  const next = clampOpening(found.wall, {
    ...found.opening,
    along: payload.along ?? found.opening.along,
    width: payload.width ?? found.opening.width,
  }, grid);
  found.opening.along = next.along;
  if (payload.width !== undefined) found.opening.width = next.width;
  return {
    type: CMD.MOVE_OPENING,
    payload: { id: found.opening.id, along: prevAlong, width: prevWidth },
  };
}

function applyDeleteOpening(doc, payload) {
  const found = getOpening(doc, payload.id);
  if (!found) throw new Error(`Opening not found: ${payload.id}`);
  const index = found.wall.openings.findIndex((o) => o.id === payload.id);
  const [opening] = found.wall.openings.splice(index, 1);
  return {
    type: CMD.ADD_OPENING,
    payload: { wallId: found.wall.id, opening: clone(opening), index },
  };
}

function applyUpdateOpening(doc, payload) {
  const found = getOpening(doc, payload.id);
  if (!found) throw new Error(`Opening not found: ${payload.id}`);
  const patch = payload.patch || {};
  const prev = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id") continue;
    prev[key] = clone(found.opening[key]);
    found.opening[key] = clone(value);
  }
  const clamped = clampOpening(found.wall, found.opening, gridOf(doc));
  found.opening.along = clamped.along;
  found.opening.width = clamped.width;
  return { type: CMD.UPDATE_OPENING, payload: { id: found.opening.id, patch: prev } };
}

function applyAddFloor(doc, payload) {
  const floor = normalizeFloor(doc, payload);
  if (getFloor(doc, floor.id)) throw new Error(`Floor already exists: ${floor.id}`);
  insertAt(doc.floors, floor, payload.index);
  stamp(payload, "floor", floor);
  return { type: CMD.DELETE_FLOOR, payload: { id: floor.id } };
}

function applyMoveFloor(doc, payload) {
  const floor = getFloor(doc, payload.id);
  if (!floor) throw new Error(`Floor not found: ${payload.id}`);
  const grid = gridOf(doc);
  const prev = { x: floor.x, y: floor.y, w: floor.w, d: floor.d };
  if (payload.dx !== undefined) floor.x = snapToGrid(floor.x + payload.dx, grid);
  if (payload.dy !== undefined) floor.y = snapToGrid(floor.y + payload.dy, grid);
  if (payload.x !== undefined) floor.x = snapToGrid(payload.x, grid);
  if (payload.y !== undefined) floor.y = snapToGrid(payload.y, grid);
  if (payload.w !== undefined) floor.w = Math.max(grid, snapToGrid(payload.w, grid));
  if (payload.d !== undefined) floor.d = Math.max(grid, snapToGrid(payload.d, grid));
  return { type: CMD.MOVE_FLOOR, payload: { id: floor.id, ...prev } };
}

function applyDeleteFloor(doc, payload) {
  const index = doc.floors.findIndex((f) => f.id === payload.id);
  if (index < 0) throw new Error(`Floor not found: ${payload.id}`);
  const [floor] = doc.floors.splice(index, 1);
  return { type: CMD.ADD_FLOOR, payload: { floor: clone(floor), index } };
}

function applyUpdateFloor(doc, payload) {
  const floor = getFloor(doc, payload.id);
  if (!floor) throw new Error(`Floor not found: ${payload.id}`);
  const patch = payload.patch || {};
  const prev = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id") continue;
    prev[key] = clone(floor[key]);
    floor[key] = clone(value);
  }
  return { type: CMD.UPDATE_FLOOR, payload: { id: floor.id, patch: prev } };
}

function applyAddStair(doc, payload) {
  const stair = normalizeStair(doc, payload);
  if (getStair(doc, stair.id)) throw new Error(`Stair already exists: ${stair.id}`);
  insertAt(doc.stairs, stair, payload.index);
  stamp(payload, "stair", stair);
  return { type: CMD.DELETE_STAIR, payload: { id: stair.id } };
}

function applyMoveStair(doc, payload) {
  const stair = getStair(doc, payload.id);
  if (!stair) throw new Error(`Stair not found: ${payload.id}`);
  const grid = gridOf(doc);
  const prev = { x: stair.x, y: stair.y, w: stair.w, d: stair.d };
  if (payload.dx !== undefined) stair.x = snapToGrid(stair.x + payload.dx, grid);
  if (payload.dy !== undefined) stair.y = snapToGrid(stair.y + payload.dy, grid);
  if (payload.x !== undefined) stair.x = snapToGrid(payload.x, grid);
  if (payload.y !== undefined) stair.y = snapToGrid(payload.y, grid);
  if (payload.w !== undefined) stair.w = Math.max(grid, snapToGrid(payload.w, grid));
  if (payload.d !== undefined) stair.d = Math.max(grid, snapToGrid(payload.d, grid));
  return { type: CMD.MOVE_STAIR, payload: { id: stair.id, ...prev } };
}

function applyDeleteStair(doc, payload) {
  const index = doc.stairs.findIndex((s) => s.id === payload.id);
  if (index < 0) throw new Error(`Stair not found: ${payload.id}`);
  const [stair] = doc.stairs.splice(index, 1);
  return { type: CMD.ADD_STAIR, payload: { stair: clone(stair), index } };
}

function applyUpdateStair(doc, payload) {
  const stair = getStair(doc, payload.id);
  if (!stair) throw new Error(`Stair not found: ${payload.id}`);
  const patch = payload.patch || {};
  const prev = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id") continue;
    prev[key] = clone(stair[key]);
    stair[key] = key === "steps" ? Math.max(1, Math.round(value)) : clone(value);
  }
  return { type: CMD.UPDATE_STAIR, payload: { id: stair.id, patch: prev } };
}

function applyAddFurniture(doc, payload) {
  const item = normalizeFurniture(doc, payload);
  if (getFurniture(doc, item.id)) throw new Error(`Furniture already exists: ${item.id}`);
  insertAt(doc.furniture, item, payload.index);
  stamp(payload, "furniture", item);
  return { type: CMD.DELETE_FURNITURE, payload: { id: item.id } };
}

function applyMoveFurniture(doc, payload) {
  const item = getFurniture(doc, payload.id);
  if (!item) throw new Error(`Furniture not found: ${payload.id}`);
  const grid = gridOf(doc);
  const prev = { x: item.x, y: item.y, rot: item.rot, sx: item.sx, sy: item.sy, sz: item.sz };
  if (payload.dx !== undefined) item.x = snapToGrid(item.x + payload.dx, grid);
  if (payload.dy !== undefined) item.y = snapToGrid(item.y + payload.dy, grid);
  if (payload.x !== undefined) item.x = snapToGrid(payload.x, grid);
  if (payload.y !== undefined) item.y = snapToGrid(payload.y, grid);
  if (payload.rot !== undefined) item.rot = payload.rot;
  if (payload.sx !== undefined) item.sx = payload.sx;
  if (payload.sy !== undefined) item.sy = payload.sy;
  if (payload.sz !== undefined) item.sz = payload.sz;
  return { type: CMD.MOVE_FURNITURE, payload: { id: item.id, ...prev } };
}

function applyDeleteFurniture(doc, payload) {
  const index = doc.furniture.findIndex((f) => f.id === payload.id);
  if (index < 0) throw new Error(`Furniture not found: ${payload.id}`);
  const [item] = doc.furniture.splice(index, 1);
  return { type: CMD.ADD_FURNITURE, payload: { furniture: clone(item), index } };
}

function applyUpdateFurniture(doc, payload) {
  const item = getFurniture(doc, payload.id);
  if (!item) throw new Error(`Furniture not found: ${payload.id}`);
  const patch = payload.patch || {};
  const prev = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id") continue;
    prev[key] = clone(item[key]);
    item[key] = clone(value);
  }
  return { type: CMD.UPDATE_FURNITURE, payload: { id: item.id, patch: prev } };
}

function applyAddMaterial(doc, payload) {
  const material = normalizeMaterial(payload);
  if (getMaterial(doc, material.id)) throw new Error(`Material already exists: ${material.id}`);
  insertAt(doc.materials, material, payload.index);
  stamp(payload, "material", material);
  return { type: CMD.DELETE_MATERIAL, payload: { id: material.id } };
}

function applyUpdateMaterial(doc, payload) {
  const material = getMaterial(doc, payload.id);
  if (!material) throw new Error(`Material not found: ${payload.id}`);
  const patch = payload.patch || {};
  const prev = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id") continue;
    prev[key] = clone(material[key]);
    if (value === undefined || value === null) delete material[key];
    else material[key] = clone(value);
  }
  return { type: CMD.UPDATE_MATERIAL, payload: { id: material.id, patch: prev } };
}

function applyDeleteMaterial(doc, payload) {
  const index = doc.materials.findIndex((m) => m.id === payload.id);
  if (index < 0) throw new Error(`Material not found: ${payload.id}`);
  const [material] = doc.materials.splice(index, 1);
  return { type: CMD.ADD_MATERIAL, payload: { material: clone(material), index } };
}

function applyAddAsset(doc, payload) {
  const asset = normalizeAsset(payload);
  if (getAsset(doc, asset.id)) throw new Error(`Asset already exists: ${asset.id}`);
  insertAt(doc.assets, asset, payload.index);
  stamp(payload, "asset", asset);
  return { type: CMD.DELETE_ASSET, payload: { id: asset.id } };
}

function applyUpdateAsset(doc, payload) {
  const asset = getAsset(doc, payload.id);
  if (!asset) throw new Error(`Asset not found: ${payload.id}`);
  const patch = payload.patch || {};
  const prev = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id") continue;
    prev[key] = clone(asset[key]);
    asset[key] = clone(value);
  }
  return { type: CMD.UPDATE_ASSET, payload: { id: asset.id, patch: prev } };
}

function applyDeleteAsset(doc, payload) {
  const index = doc.assets.findIndex((a) => a.id === payload.id);
  if (index < 0) throw new Error(`Asset not found: ${payload.id}`);
  const [asset] = doc.assets.splice(index, 1);
  return { type: CMD.ADD_ASSET, payload: { asset: clone(asset), index } };
}

function applyUpdateProject(doc, payload) {
  const patch = payload.patch || payload;
  const prev = {};
  if (patch.name !== undefined) {
    prev.name = doc.project.name;
    doc.project.name = patch.name;
  }
  if (patch.grid !== undefined) {
    prev.grid = doc.project.grid;
    doc.project.grid = patch.grid > 0 ? patch.grid : GRID;
  }
  if (patch.wallDefaults !== undefined) {
    prev.wallDefaults = clone(doc.project.wallDefaults);
    doc.project.wallDefaults = { ...doc.project.wallDefaults, ...patch.wallDefaults };
  }
  return { type: CMD.UPDATE_PROJECT, payload: { patch: prev } };
}

const HANDLERS = {
  [CMD.ADD_WALL]: applyAddWall,
  [CMD.MOVE_WALL]: applyMoveWall,
  [CMD.DELETE_WALL]: applyDeleteWall,
  [CMD.UPDATE_WALL]: applyUpdateWall,
  [CMD.ADD_OPENING]: applyAddOpening,
  [CMD.MOVE_OPENING]: applyMoveOpening,
  [CMD.DELETE_OPENING]: applyDeleteOpening,
  [CMD.UPDATE_OPENING]: applyUpdateOpening,
  [CMD.ADD_FLOOR]: applyAddFloor,
  [CMD.MOVE_FLOOR]: applyMoveFloor,
  [CMD.DELETE_FLOOR]: applyDeleteFloor,
  [CMD.UPDATE_FLOOR]: applyUpdateFloor,
  [CMD.ADD_STAIR]: applyAddStair,
  [CMD.MOVE_STAIR]: applyMoveStair,
  [CMD.DELETE_STAIR]: applyDeleteStair,
  [CMD.UPDATE_STAIR]: applyUpdateStair,
  [CMD.ADD_FURNITURE]: applyAddFurniture,
  [CMD.MOVE_FURNITURE]: applyMoveFurniture,
  [CMD.DELETE_FURNITURE]: applyDeleteFurniture,
  [CMD.UPDATE_FURNITURE]: applyUpdateFurniture,
  [CMD.ADD_MATERIAL]: applyAddMaterial,
  [CMD.UPDATE_MATERIAL]: applyUpdateMaterial,
  [CMD.DELETE_MATERIAL]: applyDeleteMaterial,
  [CMD.ADD_ASSET]: applyAddAsset,
  [CMD.UPDATE_ASSET]: applyUpdateAsset,
  [CMD.DELETE_ASSET]: applyDeleteAsset,
  [CMD.UPDATE_PROJECT]: applyUpdateProject,
};

/**
 * Mutate `doc` with a serializable `{ type, payload }` command.
 * @returns {object} inverse command (also serializable)
 */
export function executeCommand(doc, command) {
  if (!command || typeof command.type !== "string") throw new Error("Invalid command");
  const handler = HANDLERS[command.type];
  if (!handler) throw new Error(`Unknown command: ${command.type}`);
  return handler(doc, command.payload ?? {});
}

/**
 * Apply a command on a session and record it for Ctrl+Z / Ctrl+Y.
 * Generated ids are written onto the stored command so redo is stable.
 * @param {{ doc: object, undoStack: object[], redoStack: object[] }} session
 * @param {{ type: string, payload?: object }} command
 * @returns {{ type: string, payload?: object }} the stored forward command
 */
export function applyCommand(session, command) {
  if (!session?.doc) throw new Error("applyCommand requires a session");
  const forward = clone(command);
  const inverse = executeCommand(session.doc, forward);
  session.undoStack.push({ command: clone(forward), inverse: clone(inverse) });
  if (session.undoStack.length > UNDO_LIMIT) session.undoStack.shift();
  session.redoStack.length = 0;
  return forward;
}

/** @returns {object | null} inverse command that was applied */
export function undo(session) {
  if (!canUndo(session)) return null;
  const entry = session.undoStack[session.undoStack.length - 1];
  executeCommand(session.doc, entry.inverse);
  session.undoStack.pop();
  session.redoStack.push(entry);
  return entry.inverse;
}

/** @returns {object | null} forward command that was applied */
export function redo(session) {
  if (!canRedo(session)) return null;
  const entry = session.redoStack[session.redoStack.length - 1];
  executeCommand(session.doc, entry.command);
  session.redoStack.pop();
  session.undoStack.push(entry);
  return entry.command;
}

export function cmdAddWall(fields) {
  return { type: CMD.ADD_WALL, payload: { ...fields } };
}
export function cmdMoveWall(id, fields) {
  return { type: CMD.MOVE_WALL, payload: { id, ...fields } };
}
export function cmdDeleteWall(id) {
  return { type: CMD.DELETE_WALL, payload: { id } };
}
export function cmdUpdateWall(id, patch) {
  return { type: CMD.UPDATE_WALL, payload: { id, patch } };
}
export function cmdAddOpening(wallId, fields) {
  return { type: CMD.ADD_OPENING, payload: { wallId, ...fields } };
}
export function cmdMoveOpening(id, fields) {
  return { type: CMD.MOVE_OPENING, payload: { id, ...fields } };
}
export function cmdDeleteOpening(id) {
  return { type: CMD.DELETE_OPENING, payload: { id } };
}
export function cmdUpdateOpening(id, patch) {
  return { type: CMD.UPDATE_OPENING, payload: { id, patch } };
}
export function cmdAddFloor(fields) {
  return { type: CMD.ADD_FLOOR, payload: { ...fields } };
}
export function cmdMoveFloor(id, fields) {
  return { type: CMD.MOVE_FLOOR, payload: { id, ...fields } };
}
export function cmdDeleteFloor(id) {
  return { type: CMD.DELETE_FLOOR, payload: { id } };
}
export function cmdUpdateFloor(id, patch) {
  return { type: CMD.UPDATE_FLOOR, payload: { id, patch } };
}
export function cmdAddStair(fields) {
  return { type: CMD.ADD_STAIR, payload: { ...fields } };
}
export function cmdMoveStair(id, fields) {
  return { type: CMD.MOVE_STAIR, payload: { id, ...fields } };
}
export function cmdDeleteStair(id) {
  return { type: CMD.DELETE_STAIR, payload: { id } };
}
export function cmdUpdateStair(id, patch) {
  return { type: CMD.UPDATE_STAIR, payload: { id, patch } };
}
export function cmdAddFurniture(fields) {
  return { type: CMD.ADD_FURNITURE, payload: { ...fields } };
}
export function cmdMoveFurniture(id, fields) {
  return { type: CMD.MOVE_FURNITURE, payload: { id, ...fields } };
}
export function cmdDeleteFurniture(id) {
  return { type: CMD.DELETE_FURNITURE, payload: { id } };
}
export function cmdUpdateFurniture(id, patch) {
  return { type: CMD.UPDATE_FURNITURE, payload: { id, patch } };
}
export function cmdAddMaterial(fields) {
  return { type: CMD.ADD_MATERIAL, payload: { ...fields } };
}
export function cmdUpdateMaterial(id, patch) {
  return { type: CMD.UPDATE_MATERIAL, payload: { id, patch } };
}
export function cmdDeleteMaterial(id) {
  return { type: CMD.DELETE_MATERIAL, payload: { id } };
}
export function cmdAddAsset(fields) {
  return { type: CMD.ADD_ASSET, payload: { ...fields } };
}
export function cmdUpdateAsset(id, patch) {
  return { type: CMD.UPDATE_ASSET, payload: { id, patch } };
}
export function cmdDeleteAsset(id) {
  return { type: CMD.DELETE_ASSET, payload: { id } };
}
export function cmdUpdateProject(patch) {
  return { type: CMD.UPDATE_PROJECT, payload: { patch } };
}

export const commands = {
  addWall: cmdAddWall,
  moveWall: cmdMoveWall,
  deleteWall: cmdDeleteWall,
  updateWall: cmdUpdateWall,
  addOpening: cmdAddOpening,
  moveOpening: cmdMoveOpening,
  deleteOpening: cmdDeleteOpening,
  updateOpening: cmdUpdateOpening,
  addFloor: cmdAddFloor,
  moveFloor: cmdMoveFloor,
  deleteFloor: cmdDeleteFloor,
  updateFloor: cmdUpdateFloor,
  addStair: cmdAddStair,
  moveStair: cmdMoveStair,
  deleteStair: cmdDeleteStair,
  updateStair: cmdUpdateStair,
  addFurniture: cmdAddFurniture,
  moveFurniture: cmdMoveFurniture,
  deleteFurniture: cmdDeleteFurniture,
  updateFurniture: cmdUpdateFurniture,
  addMaterial: cmdAddMaterial,
  updateMaterial: cmdUpdateMaterial,
  deleteMaterial: cmdDeleteMaterial,
  addAsset: cmdAddAsset,
  updateAsset: cmdUpdateAsset,
  deleteAsset: cmdDeleteAsset,
  updateProject: cmdUpdateProject,
};
