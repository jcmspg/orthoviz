/**
 * Orthogonal apartment builder — Canvas 2D plan editor.
 * All document mutations go through model.applyCommand so undo stays consistent.
 */

import {
  GRID,
  OPENING_DEFAULTS,
  applyCommand,
  undo,
  redo,
  commands,
  snapPoint,
  snapToGrid,
  clampOrtho,
  orthoSegment,
  wallLength,
  isHorizontal,
  alongAtPoint,
  pointAtAlong,
  getWall,
  getFloor,
  getStair,
  getOpening,
  getMaterial,
  getProjectGrid,
  extents,
  canUndo,
  canRedo,
} from "./model.js";

export const TOOLS = Object.freeze({
  SELECT: "select",
  WALL: "wall",
  DOOR: "door",
  WINDOW: "window",
  FLOOR: "floor",
  STAIR: "stair",
});

const EPS = 1e-9;
const HIT_PX = 10;
const MIN_WALL_M = GRID;
const MIN_FLOOR_M = GRID;
const RULER_PAD_M = 0.35;
const ZOOM_MIN = 8;
const ZOOM_MAX = 220;
const ZOOM_DEFAULT = 48;

/**
 * @typedef {{ kind: 'wall'|'floor'|'stair'|'opening'|null, id: string|null, wallId?: string|null }} PlanSelection
 */

/**
 * Create a top-down ortho plan editor bound to a canvas and model session.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ doc: object, undoStack: object[], redoStack: object[] }} session
 * @param {{
 *   onChange?: (session: object, meta?: object) => void,
 *   onSelectionChange?: (selection: PlanSelection) => void,
 *   onToolChange?: (tool: string) => void,
 *   host?: HTMLElement|null,
 *   showHint?: boolean,
 * }} [options]
 */
export function createPlan2D(canvas, session, options = {}) {
  if (!canvas || typeof canvas.getContext !== "function") {
    throw new Error("createPlan2D requires a canvas element");
  }
  if (!session?.doc) {
    throw new Error("createPlan2D requires a model session");
  }

  const ctx = canvas.getContext("2d");
  const listeners = {
    change: new Set(),
    selection: new Set(),
    tool: new Set(),
  };

  if (typeof options.onChange === "function") listeners.change.add(options.onChange);
  if (typeof options.onSelectionChange === "function") listeners.selection.add(options.onSelectionChange);
  if (typeof options.onToolChange === "function") listeners.tool.add(options.onToolChange);

  let host = options.host || canvas.parentElement;
  if (host && !host.classList.contains("plan2d-host")) {
    host.classList.add("plan2d-host");
  }

  let hintEl = null;
  if (options.showHint !== false && host) {
    hintEl = host.querySelector(".plan2d-hint");
    if (!hintEl) {
      hintEl = document.createElement("p");
      hintEl.className = "plan2d-hint";
      host.appendChild(hintEl);
    }
  }

  /** @type {{ doc: object, undoStack: object[], redoStack: object[] }} */
  let activeSession = session;
  let tool = TOOLS.SELECT;
  /** @type {PlanSelection} */
  let selection = { kind: null, id: null, wallId: null };

  const view = {
    scale: ZOOM_DEFAULT,
    ox: 0,
    oy: 0,
  };

  /** @type {null | object} */
  let draft = null;
  /** @type {null | object} */
  let drag = null;
  /** @type {null | { wallId: string, dist: number }} */
  let hoverWall = null;
  /** @type {PlanSelection} */
  let hoverSelection = { kind: null, id: null, wallId: null };
  let pointerWorld = { x: 0, y: 0 };
  let spaceDown = false;
  let panning = false;
  let panLast = null;
  let destroyed = false;
  let raf = 0;

  function emit(event, ...args) {
    for (const fn of listeners[event] || []) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[plan2d] ${event} listener failed`, err);
      }
    }
  }

  function setHint(text) {
    if (hintEl) hintEl.textContent = text || "";
  }

  function updateHostAttrs() {
    if (!host) return;
    host.dataset.tool = tool;
    host.dataset.panning = panning ? "true" : "false";
    host.dataset.dragging = drag ? "true" : "false";
  }

  function grid() {
    return getProjectGrid(activeSession.doc) || GRID;
  }

  function scheduleDraw() {
    if (destroyed || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      draw();
    });
  }

  function resize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = Math.max(1, canvas.clientWidth || canvas.width || 1);
    const cssH = Math.max(1, canvas.clientHeight || canvas.height || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scheduleDraw();
  }

  function cssSize() {
    return {
      w: canvas.clientWidth || canvas.width || 1,
      h: canvas.clientHeight || canvas.height || 1,
    };
  }

  /** Screen (CSS px) → world meters. Plan Y increases up on screen. */
  function screenToWorld(sx, sy) {
    const { h } = cssSize();
    return {
      x: (sx - view.ox) / view.scale,
      y: (h - sy - view.oy) / view.scale,
    };
  }

  function worldToScreen(x, y) {
    const { h } = cssSize();
    return {
      x: view.ox + x * view.scale,
      y: h - view.oy - y * view.scale,
    };
  }

  function snapWorld(x, y) {
    return snapPoint(x, y, grid());
  }

  function metersToLabel(m) {
    if (!Number.isFinite(m)) return "—";
    const abs = Math.abs(m);
    if (abs >= 10) return `${m.toFixed(1)} m`;
    if (abs >= 1) return `${m.toFixed(2)} m`;
    return `${Math.round(m * 1000)} mm`;
  }

  function notifyDoc(meta = {}) {
    scheduleDraw();
    emit("change", activeSession, meta);
  }

  function setSelectionInternal(next, { silent = false } = {}) {
    const norm = normalizeSelection(next);
    const prev = selection;
    const same =
      prev.kind === norm.kind &&
      prev.id === norm.id &&
      (prev.wallId || null) === (norm.wallId || null);
    selection = norm;
    if (!same && !silent) {
      emit("selection", { ...selection });
      scheduleDraw();
    }
    updateHintForIdle();
  }

  function normalizeSelection(sel) {
    if (!sel || !sel.kind || !sel.id) return { kind: null, id: null, wallId: null };
    if (sel.kind === "wall") return { kind: "wall", id: sel.id, wallId: sel.id };
    if (sel.kind === "floor") return { kind: "floor", id: sel.id, wallId: null };
    if (sel.kind === "stair") return { kind: "stair", id: sel.id, wallId: null };
    if (sel.kind === "opening") {
      return { kind: "opening", id: sel.id, wallId: sel.wallId || null };
    }
    return { kind: null, id: null, wallId: null };
  }

  function updateHintForIdle() {
    if (draft || drag || panning) return;
    const ext = extents(activeSession.doc);
    const isEmpty = ext.width <= EPS && ext.depth <= EPS;
    if (isEmpty && tool === TOOLS.SELECT) {
      setHint("Click Wall, drag to draw");
      return;
    }
    if (tool === TOOLS.SELECT) {
      setHint(selection.kind ? "Drag to move · Del to delete · Esc clears" : "Select a wall, floor, stair, or opening");
    } else if (tool === TOOLS.WALL) {
      setHint("Click-drag an axis-aligned wall");
    } else if (tool === TOOLS.FLOOR) {
      setHint("Click-drag a floor rectangle");
    } else if (tool === TOOLS.STAIR) {
      setHint("Click-drag a stair rectangle");
    } else if (tool === TOOLS.DOOR) {
      setHint("Click a wall, then drag door width along it");
    } else if (tool === TOOLS.WINDOW) {
      setHint("Click a wall, then drag window width along it");
    }
  }

  // --- hit testing ---------------------------------------------------------

  function distPointSeg(px, py, x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    if (len2 < EPS) return Math.hypot(px - x0, py - y0);
    let t = ((px - x0) * dx + (py - y0) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
  }

  function hitTolM() {
    return HIT_PX / view.scale;
  }

  function nearestWall(wx, wy, tol = hitTolM()) {
    let best = null;
    for (const wall of activeSession.doc.walls) {
      const half = (wall.thickness || 0.1) * 0.5;
      const d = distPointSeg(wx, wy, wall.x0, wall.y0, wall.x1, wall.y1);
      const limit = Math.max(tol, half + 0.02);
      if (d <= limit && (!best || d < best.dist)) {
        best = { wallId: wall.id, wall, dist: d, along: alongAtPoint(wall, wx, wy) };
      }
    }
    return best;
  }

  function hitOpening(wx, wy, tol = hitTolM()) {
    let best = null;
    for (const wall of activeSession.doc.walls) {
      for (const opening of wall.openings || []) {
        const a = pointAtAlong(wall, opening.along);
        const b = pointAtAlong(wall, opening.along + opening.width);
        const d = distPointSeg(wx, wy, a.x, a.y, b.x, b.y);
        const half = (wall.thickness || 0.1) * 0.5 + 0.04;
        if (d <= Math.max(tol, half) && (!best || d < best.dist)) {
          best = {
            kind: "opening",
            id: opening.id,
            wallId: wall.id,
            dist: d,
          };
        }
      }
    }
    return best;
  }

  function hitFloor(wx, wy) {
    const floors = activeSession.doc.floors;
    for (let i = floors.length - 1; i >= 0; i -= 1) {
      const f = floors[i];
      if (wx >= f.x && wx <= f.x + f.w && wy >= f.y && wy <= f.y + f.d) {
        return { kind: "floor", id: f.id, wallId: null };
      }
    }
    return null;
  }

  function hitStair(wx, wy) {
    const stairs = activeSession.doc.stairs || [];
    for (let i = stairs.length - 1; i >= 0; i -= 1) {
      const s = stairs[i];
      if (wx >= s.x && wx <= s.x + s.w && wy >= s.y && wy <= s.y + s.d) {
        return { kind: "stair", id: s.id, wallId: null };
      }
    }
    return null;
  }

  function hitTest(wx, wy) {
    const opening = hitOpening(wx, wy);
    if (opening) return opening;
    const wall = nearestWall(wx, wy);
    if (wall) return { kind: "wall", id: wall.wallId, wallId: wall.wallId };
    const stair = hitStair(wx, wy);
    if (stair) return stair;
    const floor = hitFloor(wx, wy);
    if (floor) return floor;
    return { kind: null, id: null, wallId: null };
  }

  // --- commands ------------------------------------------------------------

  function commit(command, meta = {}) {
    const stored = applyCommand(activeSession, command);
    notifyDoc({ ...meta, command: stored });
    return stored;
  }

  function deleteSelection() {
    if (!selection.kind || !selection.id) return false;
    const label =
      selection.kind === "opening"
        ? "this opening"
        : selection.kind === "wall"
          ? "this wall"
          : selection.kind === "floor"
            ? "this floor"
            : "this stair";
    const ok = typeof window.confirm === "function" ? window.confirm(`Delete ${label}?`) : true;
    if (!ok) return false;
    if (selection.kind === "wall") {
      commit(commands.deleteWall(selection.id), { reason: "delete" });
    } else if (selection.kind === "floor") {
      commit(commands.deleteFloor(selection.id), { reason: "delete" });
    } else if (selection.kind === "stair") {
      commit(commands.deleteStair(selection.id), { reason: "delete" });
    } else if (selection.kind === "opening") {
      commit(commands.deleteOpening(selection.id), { reason: "delete" });
    } else {
      return false;
    }
    setSelectionInternal({ kind: null, id: null });
    return true;
  }

  function cancelDraft() {
    draft = null;
    drag = null;
    updateHostAttrs();
    updateHintForIdle();
    scheduleDraw();
  }

  // --- tool actions --------------------------------------------------------

  function beginWall(wx, wy) {
    const p = snapWorld(wx, wy);
    draft = { type: "wall", x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    setHint("Drag to set wall length · Esc cancel");
  }

  function updateWallDraft(wx, wy) {
    if (!draft || draft.type !== "wall") return;
    const p = snapWorld(wx, wy);
    const seg = clampOrtho(draft.x0, draft.y0, p.x, p.y);
    draft.x1 = snapToGrid(seg.x1, grid());
    draft.y1 = snapToGrid(seg.y1, grid());
    const len = Math.hypot(draft.x1 - draft.x0, draft.y1 - draft.y0);
    setHint(`Wall ${metersToLabel(len)} · Esc cancel`);
  }

  function finishWall() {
    if (!draft || draft.type !== "wall") return;
    const seg = orthoSegment(draft.x0, draft.y0, draft.x1, draft.y1, grid());
    const len = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0);
    draft = null;
    updateHintForIdle();
    if (len < MIN_WALL_M) {
      scheduleDraw();
      return;
    }
    const stored = commit(commands.addWall(seg), { reason: "draw-wall" });
    const id = stored.payload?.wall?.id;
    if (id) setSelectionInternal({ kind: "wall", id, wallId: id });
  }

  function beginFloor(wx, wy) {
    const p = snapWorld(wx, wy);
    draft = { type: "floor", x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    setHint("Drag floor rectangle · Esc cancel");
  }

  function updateFloorDraft(wx, wy) {
    if (!draft || draft.type !== "floor") return;
    const p = snapWorld(wx, wy);
    draft.x1 = p.x;
    draft.y1 = p.y;
    const rect = normalizeRect(draft.x0, draft.y0, draft.x1, draft.y1);
    setHint(`Floor ${metersToLabel(rect.w)} × ${metersToLabel(rect.d)} · Esc cancel`);
  }

  function finishFloor() {
    if (!draft || draft.type !== "floor") return;
    const rect = normalizeRect(draft.x0, draft.y0, draft.x1, draft.y1);
    draft = null;
    updateHintForIdle();
    if (rect.w < MIN_FLOOR_M || rect.d < MIN_FLOOR_M) {
      scheduleDraw();
      return;
    }
    const stored = commit(commands.addFloor(rect), { reason: "draw-floor" });
    const id = stored.payload?.floor?.id;
    if (id) setSelectionInternal({ kind: "floor", id });
  }

  function beginStair(wx, wy) {
    const p = snapWorld(wx, wy);
    draft = { type: "stair", x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    setHint("Drag stair rectangle · Esc cancel");
  }

  function updateStairDraft(wx, wy) {
    if (!draft || draft.type !== "stair") return;
    const p = snapWorld(wx, wy);
    draft.x1 = p.x;
    draft.y1 = p.y;
    const rect = normalizeRect(draft.x0, draft.y0, draft.x1, draft.y1);
    setHint(`Stair ${metersToLabel(rect.w)} × ${metersToLabel(rect.d)} · Esc cancel`);
  }

  function finishStair() {
    if (!draft || draft.type !== "stair") return;
    const rect = normalizeRect(draft.x0, draft.y0, draft.x1, draft.y1);
    draft = null;
    updateHintForIdle();
    if (rect.w < MIN_FLOOR_M || rect.d < MIN_FLOOR_M) {
      scheduleDraw();
      return;
    }
    const stored = commit(commands.addStair(rect), { reason: "draw-stair" });
    const id = stored.payload?.stair?.id;
    if (id) setSelectionInternal({ kind: "stair", id });
  }

  function normalizeRect(x0, y0, x1, y1) {
    const g = grid();
    const a = snapPoint(x0, y0, g);
    const b = snapPoint(x1, y1, g);
    const minX = Math.min(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxX = Math.max(a.x, b.x);
    const maxY = Math.max(a.y, b.y);
    return {
      x: minX,
      y: minY,
      w: snapToGrid(maxX - minX, g),
      d: snapToGrid(maxY - minY, g),
    };
  }

  function beginOpening(wx, wy, type) {
    const hit = nearestWall(wx, wy);
    if (!hit) {
      setHint("Click closer to a wall");
      return;
    }
    const along = snapToGrid(hit.along, grid());
    draft = {
      type: "opening",
      openingType: type,
      wallId: hit.wallId,
      startAlong: along,
      endAlong: along,
    };
    setHint(`Drag ${type} width along wall · Esc cancel`);
  }

  function updateOpeningDraft(wx, wy) {
    if (!draft || draft.type !== "opening") return;
    const wall = getWall(activeSession.doc, draft.wallId);
    if (!wall) return;
    draft.endAlong = snapToGrid(alongAtPoint(wall, wx, wy), grid());
    const { along, width } = openingFromDraft(draft, wall);
    setHint(`${draft.openingType} ${metersToLabel(width)} · Esc cancel`);
    void along;
  }

  function openingFromDraft(d, wall) {
    const g = grid();
    const len = wallLength(wall);
    const defaults = OPENING_DEFAULTS[d.openingType] || OPENING_DEFAULTS.door;
    let a = Math.min(d.startAlong, d.endAlong);
    let b = Math.max(d.startAlong, d.endAlong);
    let width = snapToGrid(b - a, g);
    if (width < defaults.width * 0.5) {
      // Short drag → place default-width opening centered on start
      width = snapToGrid(defaults.width, g);
      a = snapToGrid(d.startAlong - width * 0.5, g);
    }
    width = Math.max(g, Math.min(width, snapToGrid(len, g)));
    a = Math.max(0, Math.min(a, Math.max(0, snapToGrid(len - width, g))));
    return { along: a, width };
  }

  function finishOpening() {
    if (!draft || draft.type !== "opening") return;
    const wall = getWall(activeSession.doc, draft.wallId);
    const openingType = draft.openingType;
    if (!wall) {
      draft = null;
      updateHintForIdle();
      scheduleDraw();
      return;
    }
    const { along, width } = openingFromDraft(draft, wall);
    const defaults = OPENING_DEFAULTS[openingType] || OPENING_DEFAULTS.door;
    draft = null;
    updateHintForIdle();
    if (width < MIN_WALL_M || wallLength(wall) < MIN_WALL_M) {
      scheduleDraw();
      return;
    }
    const stored = commit(
      commands.addOpening(wall.id, {
        type: openingType,
        along,
        width,
        height: defaults.height,
        sill: defaults.sill,
      }),
      { reason: `draw-${openingType}` },
    );
    const id = stored.payload?.opening?.id;
    if (id) setSelectionInternal({ kind: "opening", id, wallId: wall.id });
  }

  function beginSelectDrag(wx, wy, hit) {
    if (!hit.kind) {
      setSelectionInternal({ kind: null, id: null });
      return;
    }
    setSelectionInternal(hit);
    const g = grid();
    if (hit.kind === "wall") {
      const wall = getWall(activeSession.doc, hit.id);
      if (!wall) return;
      drag = {
        kind: "wall",
        id: wall.id,
        startX: wx,
        startY: wy,
        orig: { x0: wall.x0, y0: wall.y0, x1: wall.x1, y1: wall.y1 },
        preview: { x0: wall.x0, y0: wall.y0, x1: wall.x1, y1: wall.y1 },
      };
    } else if (hit.kind === "floor") {
      const floor = getFloor(activeSession.doc, hit.id);
      if (!floor) return;
      drag = {
        kind: "floor",
        id: floor.id,
        startX: wx,
        startY: wy,
        orig: { x: floor.x, y: floor.y, w: floor.w, d: floor.d },
        preview: { x: floor.x, y: floor.y, w: floor.w, d: floor.d },
      };
    } else if (hit.kind === "stair") {
      const stair = getStair(activeSession.doc, hit.id);
      if (!stair) return;
      drag = {
        kind: "stair",
        id: stair.id,
        startX: wx,
        startY: wy,
        orig: { x: stair.x, y: stair.y, w: stair.w, d: stair.d },
        preview: { x: stair.x, y: stair.y, w: stair.w, d: stair.d },
      };
    } else if (hit.kind === "opening") {
      const found = getOpening(activeSession.doc, hit.id);
      if (!found) return;
      drag = {
        kind: "opening",
        id: found.opening.id,
        wallId: found.wall.id,
        startAlong: alongAtPoint(found.wall, wx, wy),
        origAlong: found.opening.along,
        origWidth: found.opening.width,
        previewAlong: found.opening.along,
      };
    }
    void g;
    updateHostAttrs();
    setHint("Release to place · Esc cancel");
  }

  function updateSelectDrag(wx, wy) {
    if (!drag) return;
    const g = grid();
    if (drag.kind === "wall") {
      const dx = snapToGrid(wx - drag.startX, g);
      const dy = snapToGrid(wy - drag.startY, g);
      // Keep ortho: prefer dominant axis for free drag of whole wall
      const move = Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy };
      drag.preview = {
        x0: drag.orig.x0 + move.dx,
        y0: drag.orig.y0 + move.dy,
        x1: drag.orig.x1 + move.dx,
        y1: drag.orig.y1 + move.dy,
      };
      setHint(`Move wall ${metersToLabel(Math.hypot(move.dx, move.dy))}`);
    } else if (drag.kind === "floor") {
      const dx = snapToGrid(wx - drag.startX, g);
      const dy = snapToGrid(wy - drag.startY, g);
      drag.preview = {
        x: drag.orig.x + dx,
        y: drag.orig.y + dy,
        w: drag.orig.w,
        d: drag.orig.d,
      };
      setHint(`Move floor (${metersToLabel(dx)}, ${metersToLabel(dy)}) · ${metersToLabel(drag.preview.w)} × ${metersToLabel(drag.preview.d)}`);
    } else if (drag.kind === "stair") {
      const dx = snapToGrid(wx - drag.startX, g);
      const dy = snapToGrid(wy - drag.startY, g);
      drag.preview = {
        x: drag.orig.x + dx,
        y: drag.orig.y + dy,
        w: drag.orig.w,
        d: drag.orig.d,
      };
      setHint(`Move stair (${metersToLabel(dx)}, ${metersToLabel(dy)})`);
    } else if (drag.kind === "opening") {
      const wall = getWall(activeSession.doc, drag.wallId);
      if (!wall) return;
      const alongNow = alongAtPoint(wall, wx, wy);
      const delta = snapToGrid(alongNow - drag.startAlong, g);
      const maxAlong = Math.max(0, snapToGrid(wallLength(wall) - drag.origWidth, g));
      drag.previewAlong = Math.max(0, Math.min(drag.origAlong + delta, maxAlong));
      setHint(`Opening @ ${metersToLabel(drag.previewAlong)}`);
    }
  }

  function finishSelectDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    updateHostAttrs();
    updateHintForIdle();

    if (d.kind === "wall") {
      const moved =
        d.preview.x0 !== d.orig.x0 ||
        d.preview.y0 !== d.orig.y0 ||
        d.preview.x1 !== d.orig.x1 ||
        d.preview.y1 !== d.orig.y1;
      if (moved) {
        commit(commands.moveWall(d.id, { ...d.preview }), { reason: "move-wall" });
      } else {
        scheduleDraw();
      }
    } else if (d.kind === "floor") {
      if (d.preview.x !== d.orig.x || d.preview.y !== d.orig.y) {
        commit(commands.moveFloor(d.id, { x: d.preview.x, y: d.preview.y }), { reason: "move-floor" });
      } else {
        scheduleDraw();
      }
    } else if (d.kind === "stair") {
      if (d.preview.x !== d.orig.x || d.preview.y !== d.orig.y) {
        commit(commands.moveStair(d.id, { x: d.preview.x, y: d.preview.y }), { reason: "move-stair" });
      } else {
        scheduleDraw();
      }
    } else if (d.kind === "opening") {
      if (d.previewAlong !== d.origAlong) {
        commit(commands.moveOpening(d.id, { along: d.previewAlong }), { reason: "move-opening" });
      } else {
        scheduleDraw();
      }
    }
  }

  // --- pointer / keyboard --------------------------------------------------

  function eventToLocal(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e) {
    if (destroyed) return;
    canvas.focus({ preventScroll: true });
    const local = eventToLocal(e);
    const world = screenToWorld(local.x, local.y);
    pointerWorld = world;

    const wantPan = e.button === 1 || (e.button === 0 && (spaceDown || e.altKey));
    if (wantPan) {
      panning = true;
      panLast = { x: e.clientX, y: e.clientY };
      updateHostAttrs();
      canvas.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    canvas.setPointerCapture?.(e.pointerId);

    if (tool === TOOLS.WALL) {
      beginWall(world.x, world.y);
    } else if (tool === TOOLS.FLOOR) {
      beginFloor(world.x, world.y);
    } else if (tool === TOOLS.STAIR) {
      beginStair(world.x, world.y);
    } else if (tool === TOOLS.DOOR) {
      beginOpening(world.x, world.y, "door");
    } else if (tool === TOOLS.WINDOW) {
      beginOpening(world.x, world.y, "window");
    } else {
      beginSelectDrag(world.x, world.y, hitTest(world.x, world.y));
    }
    scheduleDraw();
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (destroyed) return;
    const local = eventToLocal(e);
    const world = screenToWorld(local.x, local.y);
    pointerWorld = world;

    if (panning && panLast) {
      const dx = e.clientX - panLast.x;
      const dy = e.clientY - panLast.y;
      panLast = { x: e.clientX, y: e.clientY };
      view.ox += dx;
      // screen Y down; world Y up → moving mouse down decreases world oy when we add dy to screen offset
      view.oy -= dy;
      scheduleDraw();
      return;
    }

    if (draft?.type === "wall") updateWallDraft(world.x, world.y);
    else if (draft?.type === "floor") updateFloorDraft(world.x, world.y);
    else if (draft?.type === "stair") updateStairDraft(world.x, world.y);
    else if (draft?.type === "opening") updateOpeningDraft(world.x, world.y);
    else if (drag) updateSelectDrag(world.x, world.y);
    else if (tool === TOOLS.DOOR || tool === TOOLS.WINDOW) {
      const hit = nearestWall(world.x, world.y);
      hoverWall = hit ? { wallId: hit.wallId, dist: hit.dist } : null;
      hoverSelection = { kind: null, id: null, wallId: null };
    } else if (!draft && !drag && !panning && tool === TOOLS.SELECT) {
      hoverWall = null;
      hoverSelection = normalizeSelection(hitTest(world.x, world.y));
    } else {
      hoverWall = null;
      hoverSelection = { kind: null, id: null, wallId: null };
    }
    scheduleDraw();
  }

  function onPointerUp(e) {
    if (destroyed) return;
    if (panning) {
      panning = false;
      panLast = null;
      updateHostAttrs();
      canvas.releasePointerCapture?.(e.pointerId);
      return;
    }
    if (e.button !== 0 && e.button !== -1) return;

    if (draft?.type === "wall") finishWall();
    else if (draft?.type === "floor") finishFloor();
    else if (draft?.type === "stair") finishStair();
    else if (draft?.type === "opening") finishOpening();
    else if (drag) finishSelectDrag();

    canvas.releasePointerCapture?.(e.pointerId);
    scheduleDraw();
  }

  function onPointerLeave() {
    hoverWall = null;
    hoverSelection = { kind: null, id: null, wallId: null };
    scheduleDraw();
  }

  function onWheel(e) {
    if (destroyed) return;
    e.preventDefault();
    const local = eventToLocal(e);
    const before = screenToWorld(local.x, local.y);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    view.scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.scale * factor));
    const after = screenToWorld(local.x, local.y);
    view.ox += (after.x - before.x) * view.scale;
    view.oy += (after.y - before.y) * view.scale;
    scheduleDraw();
  }

  function onKeyDown(e) {
    if (destroyed) return;
    const target = e.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }

    if (e.code === "Space") {
      spaceDown = true;
      e.preventDefault();
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
      if (canUndo(activeSession)) {
        undo(activeSession);
        notifyDoc({ reason: "undo" });
        pruneSelection();
      }
      e.preventDefault();
      return;
    }
    if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
      if (canRedo(activeSession)) {
        redo(activeSession);
        notifyDoc({ reason: "redo" });
        pruneSelection();
      }
      e.preventDefault();
      return;
    }

    if (e.key === "Escape") {
      if (draft || drag) {
        cancelDraft();
      } else {
        setSelectionInternal({ kind: null, id: null });
      }
      e.preventDefault();
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (deleteSelection()) e.preventDefault();
    }
  }

  function onKeyUp(e) {
    if (e.code === "Space") spaceDown = false;
  }

  function pruneSelection() {
    if (!selection.kind) return;
    if (selection.kind === "wall" && !getWall(activeSession.doc, selection.id)) {
      setSelectionInternal({ kind: null, id: null });
    } else if (selection.kind === "floor" && !getFloor(activeSession.doc, selection.id)) {
      setSelectionInternal({ kind: null, id: null });
    } else if (selection.kind === "stair" && !getStair(activeSession.doc, selection.id)) {
      setSelectionInternal({ kind: null, id: null });
    } else if (selection.kind === "opening" && !getOpening(activeSession.doc, selection.id)) {
      setSelectionInternal({ kind: null, id: null });
    } else {
      scheduleDraw();
    }
    hoverSelection = normalizeSelection(hoverSelection);
  }

  // --- drawing -------------------------------------------------------------

  function wallGeom(wall) {
    if (drag?.kind === "wall" && drag.id === wall.id) return { ...wall, ...drag.preview };
    return wall;
  }

  function floorGeom(floor) {
    if (drag?.kind === "floor" && drag.id === floor.id) return { ...floor, ...drag.preview };
    return floor;
  }

  function stairGeom(stair) {
    if (drag?.kind === "stair" && drag.id === stair.id) return { ...stair, ...drag.preview };
    return stair;
  }

  function openingAlong(wall, opening) {
    if (drag?.kind === "opening" && drag.id === opening.id) return drag.previewAlong;
    return opening.along;
  }

  function draw() {
    const { w, h } = cssSize();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#f3f1ec";
    ctx.fillRect(0, 0, w, h);

    drawGrid(w, h);
    drawFloors();
    drawStairs();
    drawWalls();
    drawDraft();
    drawExtentRulers();
    drawLiveDimension();
    ctx.restore();
  }

  function drawGrid(w, h) {
    const g = grid();
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(w, h);
    const minX = Math.min(tl.x, br.x);
    const maxX = Math.max(tl.x, br.x);
    const minY = Math.min(tl.y, br.y);
    const maxY = Math.max(tl.y, br.y);

    const majorEvery = 10; // 1.0 m when g=0.1
    ctx.lineWidth = 1;

    const x0 = Math.floor(minX / g) * g;
    for (let x = x0; x <= maxX + g; x += g) {
      const sx = worldToScreen(x, 0).x;
      const step = Math.round(x / g);
      ctx.strokeStyle = step % majorEvery === 0 ? "rgba(40, 48, 44, 0.14)" : "rgba(40, 48, 44, 0.06)";
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
      ctx.stroke();
    }
    const y0 = Math.floor(minY / g) * g;
    for (let y = y0; y <= maxY + g; y += g) {
      const sy = worldToScreen(0, y).y;
      const step = Math.round(y / g);
      ctx.strokeStyle = step % majorEvery === 0 ? "rgba(40, 48, 44, 0.14)" : "rgba(40, 48, 44, 0.06)";
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
      ctx.stroke();
    }

    // Origin crosshair
    const o = worldToScreen(0, 0);
    ctx.strokeStyle = "rgba(180, 70, 50, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(o.x - 8, o.y);
    ctx.lineTo(o.x + 8, o.y);
    ctx.moveTo(o.x, o.y - 8);
    ctx.lineTo(o.x, o.y + 8);
    ctx.stroke();
  }

  function drawFloors() {
    for (const floor of activeSession.doc.floors) {
      const f = floorGeom(floor);
      const a = worldToScreen(f.x, f.y);
      const b = worldToScreen(f.x + f.w, f.y + f.d);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const ww = Math.abs(b.x - a.x);
      const hh = Math.abs(b.y - a.y);
      const mat = getMaterial(activeSession.doc, f.materialId);
      const selected = selection.kind === "floor" && selection.id === f.id;
      const hovered = hoverSelection.kind === "floor" && hoverSelection.id === f.id;
      ctx.fillStyle = selected
        ? "rgba(46, 110, 90, 0.28)"
        : hovered
          ? "rgba(58, 124, 165, 0.22)"
          : hexToRgba(mat?.color || "#2e3631", 0.22);
      ctx.strokeStyle = selected ? "#1f6b52" : hovered ? "#3a7ca5" : "rgba(30, 40, 36, 0.35)";
      ctx.lineWidth = selected || hovered ? 2 : 1;
      ctx.beginPath();
      ctx.rect(x, y, ww, hh);
      ctx.fill();
      ctx.stroke();
    }
  }

  function drawStairs() {
    for (const stair of activeSession.doc.stairs || []) {
      const s = stairGeom(stair);
      const a = worldToScreen(s.x, s.y);
      const b = worldToScreen(s.x + s.w, s.y + s.d);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const ww = Math.abs(b.x - a.x);
      const hh = Math.abs(b.y - a.y);
      const selected = selection.kind === "stair" && selection.id === s.id;
      const hovered = hoverSelection.kind === "stair" && hoverSelection.id === s.id;
      ctx.fillStyle = selected
        ? "rgba(140, 100, 60, 0.35)"
        : hovered
          ? "rgba(176, 130, 88, 0.35)"
          : "rgba(138, 129, 120, 0.35)";
      ctx.strokeStyle = selected ? "#8a5a28" : hovered ? "#a56e34" : "rgba(90, 70, 50, 0.55)";
      ctx.lineWidth = selected || hovered ? 2 : 1;
      ctx.beginPath();
      ctx.rect(x, y, ww, hh);
      ctx.fill();
      ctx.stroke();
      // Simple tread hint
      const steps = Math.max(2, Math.min(16, s.steps || 8));
      ctx.strokeStyle = "rgba(60, 48, 36, 0.35)";
      ctx.lineWidth = 1;
      for (let i = 1; i < steps; i += 1) {
        const t = i / steps;
        const y1 = y + hh * t;
        ctx.beginPath();
        ctx.moveTo(x, y1);
        ctx.lineTo(x + ww, y1);
        ctx.stroke();
      }
    }
  }

  function drawWalls() {
    for (const wall of activeSession.doc.walls) {
      const w = wallGeom(wall);
      const selected = selection.kind === "wall" && selection.id === wall.id;
      const hoveredSel = hoverSelection.kind === "wall" && hoverSelection.id === wall.id;
      const hover =
        (tool === TOOLS.DOOR || tool === TOOLS.WINDOW) &&
        hoverWall?.wallId === wall.id &&
        !draft;
      const thicknessPx = Math.max(2, (w.thickness || 0.1) * view.scale);
      const mat = getMaterial(activeSession.doc, w.materialId);
      const color = selected ? "#1f6b52" : hover || hoveredSel ? "#3a7ca5" : mat?.color || "#8a8478";

      ctx.lineCap = "butt";
      ctx.lineJoin = "miter";
      ctx.strokeStyle = color;
      ctx.lineWidth = thicknessPx;
      ctx.globalAlpha = selected || hover || hoveredSel ? 1 : 0.92;
      const p0 = worldToScreen(w.x0, w.y0);
      const p1 = worldToScreen(w.x1, w.y1);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Punch openings as lighter gaps + symbol
      for (const opening of wall.openings || []) {
        drawOpening(
          w,
          opening,
          selected || (selection.kind === "opening" && selection.id === opening.id),
          hoverSelection.kind === "opening" && hoverSelection.id === opening.id,
        );
      }

      if (selected) {
        drawEndpointHandles(p0, p1);
      }
    }
  }

  function drawOpening(wall, opening, selected, hovered = false) {
    const along = openingAlong(wall, opening);
    const a = pointAtAlong(wall, along);
    const b = pointAtAlong(wall, along + opening.width);
    const pa = worldToScreen(a.x, a.y);
    const pb = worldToScreen(b.x, b.y);
    const thicknessPx = Math.max(3, (wall.thickness || 0.1) * view.scale + 2);

    // Clear gap
    ctx.strokeStyle = "#f3f1ec";
    ctx.lineWidth = thicknessPx;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();

    const isDoor = opening.type !== "window";
    ctx.strokeStyle = selected ? "#1f6b52" : hovered ? "#3a7ca5" : isDoor ? "#5c4030" : "#3a6a8a";
    ctx.lineWidth = selected || hovered ? 2.5 : 1.5;
    ctx.setLineDash(isDoor ? [] : [4, 3]);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Door swing hint (quarter arc in plan)
    if (isDoor) {
      const horiz = isHorizontal(wall);
      const mx = (pa.x + pb.x) / 2;
      const my = (pa.y + pb.y) / 2;
      const lenPx = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      ctx.strokeStyle = selected ? "rgba(31, 107, 82, 0.55)" : "rgba(92, 64, 48, 0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (horiz) {
        ctx.arc(pa.x, pa.y, lenPx, wall.x1 >= wall.x0 ? -Math.PI / 2 : Math.PI / 2, 0, wall.x1 >= wall.x0);
      } else {
        ctx.arc(pa.x, pa.y, lenPx, wall.y1 >= wall.y0 ? 0 : Math.PI, wall.y1 >= wall.y0 ? Math.PI / 2 : -Math.PI / 2, false);
      }
      ctx.stroke();
      void mx;
      void my;
    }
  }

  function drawEndpointHandles(p0, p1) {
    ctx.fillStyle = "#1f6b52";
    for (const p of [p0, p1]) {
      ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
    }
  }

  function drawDraft() {
    if (!draft) return;
    if (draft.type === "wall") {
      const p0 = worldToScreen(draft.x0, draft.y0);
      const p1 = worldToScreen(draft.x1, draft.y1);
      ctx.strokeStyle = "#1f6b52";
      ctx.lineWidth = Math.max(2, 0.1 * view.scale);
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (draft.type === "floor") {
      const rect = normalizeRect(draft.x0, draft.y0, draft.x1, draft.y1);
      const a = worldToScreen(rect.x, rect.y);
      const b = worldToScreen(rect.x + rect.w, rect.y + rect.d);
      ctx.fillStyle = "rgba(31, 107, 82, 0.12)";
      ctx.strokeStyle = "#1f6b52";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (draft.type === "stair") {
      const rect = normalizeRect(draft.x0, draft.y0, draft.x1, draft.y1);
      const a = worldToScreen(rect.x, rect.y);
      const b = worldToScreen(rect.x + rect.w, rect.y + rect.d);
      ctx.fillStyle = "rgba(138, 100, 60, 0.18)";
      ctx.strokeStyle = "#8a5a28";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (draft.type === "opening") {
      const wall = getWall(activeSession.doc, draft.wallId);
      if (!wall) return;
      const { along, width } = openingFromDraft(draft, wall);
      const a = pointAtAlong(wall, along);
      const b = pointAtAlong(wall, along + width);
      const pa = worldToScreen(a.x, a.y);
      const pb = worldToScreen(b.x, b.y);
      ctx.strokeStyle = draft.openingType === "window" ? "#3a6a8a" : "#5c4030";
      ctx.lineWidth = Math.max(3, (wall.thickness || 0.1) * view.scale + 2);
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawExtentRulers() {
    const ext = extents(activeSession.doc);
    if (ext.width <= EPS && ext.depth <= EPS) return;

    const minX = ext.minX;
    const maxX = ext.maxX;
    const minY = ext.minY;
    const maxY = ext.maxY;
    const pad = RULER_PAD_M;

    // Bottom exterior width (below plan)
    const yRuler = minY - pad;
    drawDimLine(
      { x: minX, y: yRuler },
      { x: maxX, y: yRuler },
      metersToLabel(ext.width),
      "below",
    );
    // Left exterior depth
    const xRuler = minX - pad;
    drawDimLine(
      { x: xRuler, y: minY },
      { x: xRuler, y: maxY },
      metersToLabel(ext.depth),
      "left",
    );
  }

  function drawLiveDimension() {
    if (draft?.type === "wall") {
      const len = Math.hypot(draft.x1 - draft.x0, draft.y1 - draft.y0);
      if (len > EPS) {
        drawDimLine(
          { x: draft.x0, y: draft.y0 },
          { x: draft.x1, y: draft.y1 },
          metersToLabel(len),
          "auto",
        );
      }
      return;
    }
    if (draft?.type === "floor") {
      const rect = normalizeRect(draft.x0, draft.y0, draft.x1, draft.y1);
      if (rect.w > EPS) {
        drawDimLine(
          { x: rect.x, y: rect.y + rect.d },
          { x: rect.x + rect.w, y: rect.y + rect.d },
          metersToLabel(rect.w),
          "above",
        );
      }
      if (rect.d > EPS) {
        drawDimLine(
          { x: rect.x + rect.w, y: rect.y },
          { x: rect.x + rect.w, y: rect.y + rect.d },
          metersToLabel(rect.d),
          "right",
        );
      }
      return;
    }
    if (draft?.type === "stair") {
      const rect = normalizeRect(draft.x0, draft.y0, draft.x1, draft.y1);
      if (rect.w > EPS) {
        drawDimLine(
          { x: rect.x, y: rect.y + rect.d },
          { x: rect.x + rect.w, y: rect.y + rect.d },
          metersToLabel(rect.w),
          "above",
        );
      }
      if (rect.d > EPS) {
        drawDimLine(
          { x: rect.x + rect.w, y: rect.y },
          { x: rect.x + rect.w, y: rect.y + rect.d },
          metersToLabel(rect.d),
          "right",
        );
      }
      return;
    }
    if (drag?.kind === "floor") {
      const f = drag.preview;
      if (f) {
        drawDimLine(
          { x: f.x, y: f.y + f.d },
          { x: f.x + f.w, y: f.y + f.d },
          metersToLabel(f.w),
          "above",
        );
        drawDimLine(
          { x: f.x + f.w, y: f.y },
          { x: f.x + f.w, y: f.y + f.d },
          metersToLabel(f.d),
          "right",
        );
      }
      return;
    }
    if (draft?.type === "opening") {
      const wall = getWall(activeSession.doc, draft.wallId);
      if (!wall) return;
      const { along, width } = openingFromDraft(draft, wall);
      const a = pointAtAlong(wall, along);
      const b = pointAtAlong(wall, along + width);
      drawDimLine(a, b, metersToLabel(width), "auto");
    }
  }

  function drawDimLine(a, b, label, side) {
    const pa = worldToScreen(a.x, a.y);
    const pb = worldToScreen(b.x, b.y);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy);
    if (len < 2) return;
    const ux = dx / len;
    const uy = dy / len;
    let nx = -uy;
    let ny = ux;
    const offset = 14;
    if (side === "below") {
      nx = 0;
      ny = 1;
    } else if (side === "above") {
      nx = 0;
      ny = -1;
    } else if (side === "left") {
      nx = -1;
      ny = 0;
    } else if (side === "right") {
      nx = 1;
      ny = 0;
    } else {
      // Prefer label offset toward top-left of screen for readability
      if (ny > 0) {
        nx = -nx;
        ny = -ny;
      }
    }

    const qa = { x: pa.x + nx * offset, y: pa.y + ny * offset };
    const qb = { x: pb.x + nx * offset, y: pb.y + ny * offset };

    ctx.strokeStyle = "rgba(30, 40, 36, 0.55)";
    ctx.fillStyle = "rgba(30, 40, 36, 0.82)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(qa.x, qa.y);
    ctx.lineTo(qb.x, qb.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();

    // End ticks
    const tick = 5;
    ctx.beginPath();
    ctx.moveTo(qa.x - ux * 0 + nx * tick * 0.2, qa.y + ny * tick * 0.2);
    ctx.lineTo(qa.x - nx * tick, qa.y - ny * tick);
    ctx.moveTo(qb.x + nx * tick * 0.2, qb.y + ny * tick * 0.2);
    ctx.lineTo(qb.x - nx * tick, qb.y - ny * tick);
    ctx.stroke();

    const mx = (qa.x + qb.x) / 2;
    const my = (qa.y + qb.y) / 2;
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = "rgba(243, 241, 236, 0.92)";
    ctx.fillRect(mx - tw / 2, my - 8, tw, 16);
    ctx.fillStyle = "rgba(30, 40, 36, 0.88)";
    ctx.fillText(label, mx, my);
  }

  function hexToRgba(hex, alpha) {
    const m = String(hex || "").trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return `rgba(46, 54, 49, ${alpha})`;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function centerOnContent() {
    const { w, h } = cssSize();
    const ext = extents(activeSession.doc);
    if (ext.width <= EPS && ext.depth <= EPS) {
      view.scale = ZOOM_DEFAULT;
      view.ox = w * 0.5;
      view.oy = h * 0.5;
      return;
    }
    const pad = 1.5;
    const spanX = Math.max(ext.width + pad * 2, 4);
    const spanY = Math.max(ext.depth + pad * 2, 4);
    view.scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min((w - 40) / spanX, (h - 40) / spanY)));
    const cx = (ext.minX + ext.maxX) / 2;
    const cy = (ext.minY + ext.maxY) / 2;
    view.ox = w * 0.5 - cx * view.scale;
    view.oy = h * 0.5 - cy * view.scale;
  }

  // --- public API ----------------------------------------------------------

  function setTool(next) {
    const t = String(next || TOOLS.SELECT).toLowerCase();
    if (!Object.values(TOOLS).includes(t)) {
      throw new Error(`Unknown tool: ${next}`);
    }
    if (tool === t) return tool;
    cancelDraft();
    tool = t;
    updateHostAttrs();
    updateHintForIdle();
    emit("tool", tool);
    scheduleDraw();
    return tool;
  }

  function setSelection(sel) {
    setSelectionInternal(sel);
    return { ...selection };
  }

  function getSelection() {
    return { ...selection };
  }

  function getTool() {
    return tool;
  }

  function setSession(next) {
    if (!next?.doc) throw new Error("setSession requires a model session");
    activeSession = next;
    cancelDraft();
    pruneSelection();
    scheduleDraw();
  }

  function getSession() {
    return activeSession;
  }

  function on(event, fn) {
    if (!listeners[event]) throw new Error(`Unknown event: ${event}`);
    if (typeof fn !== "function") throw new Error("listener must be a function");
    listeners[event].add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    listeners[event]?.delete(fn);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("resize", resize);
    for (const set of Object.values(listeners)) set.clear();
    if (hintEl && hintEl.parentElement === host) hintEl.remove();
    if (host) {
      delete host.dataset.tool;
      delete host.dataset.panning;
      delete host.dataset.dragging;
    }
  }

  // Init
  canvas.tabIndex = canvas.tabIndex >= 0 ? canvas.tabIndex : 0;
  canvas.style.touchAction = "none";
  updateHostAttrs();
  updateHintForIdle();
  resize();
  centerOnContent();
  draw();

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("resize", resize);

  return {
    setTool,
    getTool,
    setSelection,
    getSelection,
    setSession,
    getSession,
    resize,
    redraw: scheduleDraw,
    fitView: () => {
      centerOnContent();
      scheduleDraw();
    },
    /** Convert client (page) coordinates to world meters. */
    clientToWorld(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      return screenToWorld(clientX - rect.left, clientY - rect.top);
    },
    destroy,
    on,
    off,
    /** Convenience aliases for shell wiring */
    onChange: (fn) => on("change", fn),
    onSelectionChange: (fn) => on("selection", fn),
    onToolChange: (fn) => on("tool", fn),
    TOOLS,
  };
}

export default createPlan2D;
