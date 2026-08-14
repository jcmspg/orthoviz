/**
 * Orthogonal apartment builder — shell wiring for model / plan2d / view3d / assets / persist.
 */

import {
  createSession,
  resetSession,
  createBlankProject,
  applyCommand,
  undo,
  redo,
  canUndo,
  canRedo,
  commands,
  getWall,
  getFloor,
  getStair,
  getOpening,
  getFurniture,
  getMaterial,
  getAsset,
  snapPoint,
  DEFAULT_MAT_WALL_ID,
  DEFAULT_MAT_FLOOR_ID,
} from "./src/model.js";
import {
  downloadProject,
  loadProjectFile,
  saveLastProject,
  loadLastProject,
} from "./src/persist.js";
import { primitiveProvider, localGltfProvider } from "./src/assets.js";
import { createPlan2D, TOOLS } from "./src/plan2d.js";
import { createView3D } from "./src/view3d.js";
import { getStarterTemplate } from "./src/templates.js";

const PLAN_TOOLS = new Set([
  TOOLS.SELECT,
  TOOLS.WALL,
  TOOLS.DOOR,
  TOOLS.WINDOW,
  TOOLS.FLOOR,
  TOOLS.STAIR,
]);

const el = {
  toolGrid: document.getElementById("tool-grid"),
  catalog: document.getElementById("catalog-list"),
  inspector: document.getElementById("inspector"),
  status: document.getElementById("status"),
  furnitureHint: document.getElementById("furniture-hint"),
  planHost: document.getElementById("plan-host"),
  planCanvas: document.getElementById("plan-canvas"),
  viewCanvas: document.getElementById("view-canvas"),
  fileJson: document.getElementById("file-json"),
  fileGlb: document.getElementById("file-glb"),
  templateGrid: document.getElementById("template-grid"),
};

let session = bootSession();
let shellTool = TOOLS.SELECT;
let selectedAssetId = null;
/** @type {{ kind: string, id: string, wallId?: string|null } | null} */
let shellSelection = null;
let suppressPlanSel = false;
let suppressViewSel = false;

/** @type {ReturnType<typeof createPlan2D>} */
let plan2d;
/** @type {ReturnType<typeof createView3D>} */
let view3d;

plan2d = createPlan2D(el.planCanvas, session, {
  host: el.planHost,
  showHint: true,
  onChange: () => {
    syncAfterDocChange();
  },
  onSelectionChange: (sel) => {
    if (suppressPlanSel) return;
    if (sel?.kind && sel.id) {
      shellSelection = { kind: sel.kind, id: sel.id, wallId: sel.wallId ?? null };
      suppressViewSel = true;
      view3d.setSelection(shellSelection);
      suppressViewSel = false;
      if (shellSelection.kind === "furniture") view3d.setMode("edit");
      else if (view3d.getMode() === "edit") view3d.setMode("orbit");
    } else if (shellSelection && shellSelection.kind !== "furniture") {
      shellSelection = null;
      suppressViewSel = true;
      view3d.setSelection(null);
      suppressViewSel = false;
    }
    renderInspector();
  },
});

view3d = createView3D(el.viewCanvas, session, {
  onSelect: (sel) => {
    if (suppressViewSel) return;
    if (sel?.kind && sel.id) {
      shellSelection = { kind: sel.kind, id: sel.id, wallId: sel.wallId ?? null };
      if (sel.kind === "furniture") {
        view3d.setMode("edit");
        setViewModeButtons("edit");
        suppressPlanSel = true;
        plan2d.setSelection({ kind: null, id: null });
        suppressPlanSel = false;
      } else {
        suppressPlanSel = true;
        plan2d.setSelection(sel);
        suppressPlanSel = false;
      }
    } else {
      shellSelection = null;
      suppressPlanSel = true;
      plan2d.setSelection({ kind: null, id: null });
      suppressPlanSel = false;
    }
    renderInspector();
    setStatus(sel?.kind ? `Selected ${sel.kind}` : "Ready");
  },
});

function bootSession() {
  try {
    const last = loadLastProject();
    if (last) {
      const s = createSession(last);
      localGltfProvider.syncFromDocAssets(s.doc.assets);
      return s;
    }
  } catch (err) {
    console.warn("Could not load last project", err);
  }
  return createSession(createBlankProject({ name: "Untitled" }));
}

function setStatus(msg) {
  el.status.textContent = msg;
}

function persistQuiet() {
  try {
    saveLastProject(session.doc);
  } catch {
    // ignore quota / private mode
  }
}

function syncAfterDocChange() {
  view3d.rebuild();
  persistQuiet();
  updateUndoButtons();
  renderInspector();
  renderCatalog();
}

function updateUndoButtons() {
  const undoBtn = document.getElementById("btn-undo");
  const redoBtn = document.getElementById("btn-redo");
  if (undoBtn) undoBtn.disabled = !canUndo(session);
  if (redoBtn) redoBtn.disabled = !canRedo(session);
}

function setShellTool(tool) {
  shellTool = tool;
  for (const btn of el.toolGrid.querySelectorAll(".tool")) {
    btn.classList.toggle("active", btn.dataset.tool === tool);
  }
  el.planHost.dataset.shellTool = tool === "furniture" ? "furniture" : "";

  if (PLAN_TOOLS.has(tool)) {
    plan2d.setTool(tool);
    selectedAssetId = null;
    highlightCatalog();
    el.furnitureHint.textContent = "Pick an item, then click Furniture tool + plan to place.";
  } else if (tool === "furniture") {
    plan2d.setTool(TOOLS.SELECT);
    el.furnitureHint.textContent = selectedAssetId
      ? "Click the plan to place the selected piece."
      : "Select a catalog item, then click the plan.";
  }
  setStatus(`Tool: ${tool}`);
}

function catalogItems() {
  const prims = primitiveProvider.list();
  const glbs = localGltfProvider.list();
  return [...prims, ...glbs];
}

function renderCatalog() {
  const items = catalogItems();
  el.catalog.innerHTML = "";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "catalog-item" + (item.id === selectedAssetId ? " selected" : "");
    btn.dataset.assetId = item.id;
    btn.innerHTML = `<span>${escapeHtml(item.label)}</span><span class="meta">${fmtSize(item)}</span>`;
    btn.addEventListener("click", () => {
      selectedAssetId = item.id;
      setShellTool("furniture");
      highlightCatalog();
      el.furnitureHint.textContent = `Place “${item.label}” — click the 2D plan.`;
      setStatus(`Furniture: ${item.label}`);
    });
    el.catalog.appendChild(btn);
  }
}

function highlightCatalog() {
  for (const btn of el.catalog.querySelectorAll(".catalog-item")) {
    btn.classList.toggle("selected", btn.dataset.assetId === selectedAssetId);
  }
}

function fmtSize(item) {
  return `${round1(item.w)}×${round1(item.d)}×${round1(item.h)} m`;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ensureAssetInDoc(assetId) {
  if (getAsset(session.doc, assetId)) return getAsset(session.doc, assetId);
  const prim = primitiveProvider.get(assetId);
  if (prim) {
    applyCommand(session, commands.addAsset({ ...prim }));
    return getAsset(session.doc, assetId);
  }
  const glb = localGltfProvider.get(assetId);
  if (glb) {
    applyCommand(session, commands.addAsset({ ...glb }));
    return getAsset(session.doc, assetId);
  }
  return null;
}

function placeFurnitureAt(worldX, worldY) {
  if (!selectedAssetId) {
    setStatus("Pick a catalog item first");
    return;
  }
  const asset = ensureAssetInDoc(selectedAssetId);
  if (!asset) {
    setStatus("Unknown asset");
    return;
  }
  const grid = session.doc.project?.grid ?? 0.1;
  const p = snapPoint(worldX, worldY, grid);
  applyCommand(
    session,
    commands.addFurniture({
      assetId: asset.id,
      x: p.x,
      y: p.y,
      rot: 0,
    }),
  );
  const placed = session.doc.furniture[session.doc.furniture.length - 1];
  plan2d.redraw();
  view3d.rebuild();
  persistQuiet();
  updateUndoButtons();
  if (placed) {
    shellSelection = { kind: "furniture", id: placed.id };
    view3d.setSelection(shellSelection);
    view3d.setMode("edit");
    setViewModeButtons("edit");
  }
  renderInspector();
  setStatus(`Placed ${asset.label}`);
}

function onPlanPointerDownCapture(e) {
  if (shellTool !== "furniture") return;
  if (e.button !== 0) return;
  if (e.altKey || e.button === 1) return;
  e.preventDefault();
  e.stopPropagation();
  const world = plan2d.clientToWorld(e.clientX, e.clientY);
  placeFurnitureAt(world.x, world.y);
}

function renderInspector() {
  const box = el.inspector;
  if (!shellSelection?.kind || !shellSelection.id) {
    box.className = "inspector empty";
    box.textContent = "Nothing selected";
    return;
  }

  box.className = "inspector";
  const { kind, id } = shellSelection;

  if (kind === "wall") {
    const wall = getWall(session.doc, id);
    if (!wall) {
      box.className = "inspector empty";
      box.textContent = "Nothing selected";
      return;
    }
    const mat = getMaterial(session.doc, wall.materialId || DEFAULT_MAT_WALL_ID);
    box.innerHTML = `
      <div class="title">Wall</div>
      <label><span>Thickness (m)</span><input type="number" step="0.05" min="0.05" id="insp-thickness" value="${wall.thickness ?? 0.1}" /></label>
      <label><span>Height (m)</span><input type="number" step="0.05" min="0.5" id="insp-height" value="${wall.height ?? 2.6}" /></label>
      <label><span>Color</span><input type="color" id="insp-color" value="${toColorInput(mat?.color)}" /></label>
      <label><span>Texture image</span><input type="file" id="insp-texture" accept="image/*" /></label>
      <button type="button" class="btn" id="insp-clear-tex" ${mat?.textureUrl ? "" : "disabled"}>Clear texture</button>
    `;
    wireWallInspector(wall, mat);
    return;
  }

  if (kind === "floor") {
    const floor = getFloor(session.doc, id);
    if (!floor) {
      box.className = "inspector empty";
      box.textContent = "Nothing selected";
      return;
    }
    const mat = getMaterial(session.doc, floor.materialId || DEFAULT_MAT_FLOOR_ID);
    box.innerHTML = `
      <div class="title">Floor</div>
      <p class="hint">${round1(floor.w)} × ${round1(floor.d)} m</p>
      <label><span>Color</span><input type="color" id="insp-color" value="${toColorInput(mat?.color)}" /></label>
      <label><span>Texture image</span><input type="file" id="insp-texture" accept="image/*" /></label>
      <button type="button" class="btn" id="insp-clear-tex" ${mat?.textureUrl ? "" : "disabled"}>Clear texture</button>
    `;
    wireFloorInspector(floor, mat);
    return;
  }

  if (kind === "stair") {
    const stair = getStair(session.doc, id);
    if (!stair) {
      box.className = "inspector empty";
      box.textContent = "Nothing selected";
      return;
    }
    box.innerHTML = `
      <div class="title">Stair</div>
      <p class="hint">${round1(stair.w)} × ${round1(stair.d)} m · ${stair.steps || 12} steps</p>
      <label><span>Steps</span><input type="number" step="1" min="2" id="insp-steps" value="${stair.steps ?? 12}" /></label>
      <label><span>Height (m)</span><input type="number" step="0.05" min="0.5" id="insp-stair-h" value="${stair.height ?? 2.6}" /></label>
    `;
    box.querySelector("#insp-steps")?.addEventListener("change", (ev) => {
      applyCommand(session, commands.updateStair(stair.id, { steps: Number(ev.target.value) }));
      afterShellCommand();
    });
    box.querySelector("#insp-stair-h")?.addEventListener("change", (ev) => {
      applyCommand(session, commands.updateStair(stair.id, { height: Number(ev.target.value) }));
      afterShellCommand();
    });
    return;
  }

  if (kind === "opening") {
    const found = getOpening(session.doc, id);
    if (!found) {
      box.className = "inspector empty";
      box.textContent = "Nothing selected";
      return;
    }
    const o = found.opening;
    box.innerHTML = `
      <div class="title">${o.type === "window" ? "Window" : "Door"}</div>
      <p class="hint">width ${round1(o.width)} m · along ${round1(o.along)} m</p>
    `;
    return;
  }

  if (kind === "furniture") {
    const item = getFurniture(session.doc, id);
    if (!item) {
      box.className = "inspector empty";
      box.textContent = "Nothing selected";
      return;
    }
    const asset = getAsset(session.doc, item.assetId) || primitiveProvider.get(item.assetId);
    box.innerHTML = `
      <div class="title">${escapeHtml(asset?.label || "Furniture")}</div>
      <p class="hint">R = rotate 90° · Del = delete · Edit mode for gizmos</p>
      <label><span>Rotation (°)</span><input type="number" step="15" id="insp-rot" value="${item.rot ?? 0}" /></label>
    `;
    box.querySelector("#insp-rot")?.addEventListener("change", (ev) => {
      applyCommand(session, commands.updateFurniture(item.id, { rot: Number(ev.target.value) }));
      afterShellCommand();
      view3d.setSelection({ kind: "furniture", id: item.id });
    });
    return;
  }

  box.className = "inspector empty";
  box.textContent = "Nothing selected";
}

function toColorInput(color) {
  if (!color || typeof color !== "string") return "#d7d2c8";
  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) return color.length === 4
    ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
    : color;
  return "#d7d2c8";
}

function afterShellCommand() {
  plan2d.redraw();
  view3d.rebuild();
  persistQuiet();
  updateUndoButtons();
  renderInspector();
}

function wireWallInspector(wall, mat) {
  el.inspector.querySelector("#insp-thickness")?.addEventListener("change", (ev) => {
    applyCommand(session, commands.updateWall(wall.id, { thickness: Number(ev.target.value) }));
    afterShellCommand();
  });
  el.inspector.querySelector("#insp-height")?.addEventListener("change", (ev) => {
    applyCommand(session, commands.updateWall(wall.id, { height: Number(ev.target.value) }));
    afterShellCommand();
  });
  wireMaterialControls(wall.materialId || DEFAULT_MAT_WALL_ID, mat, (materialId) => {
    if (materialId !== wall.materialId) {
      applyCommand(session, commands.updateWall(wall.id, { materialId }));
    }
  });
}

function wireFloorInspector(floor, mat) {
  wireMaterialControls(floor.materialId || DEFAULT_MAT_FLOOR_ID, mat, (materialId) => {
    if (materialId !== floor.materialId) {
      applyCommand(session, commands.updateFloor(floor.id, { materialId }));
    }
  });
}

function wireMaterialControls(materialId, mat, onEnsure) {
  el.inspector.querySelector("#insp-color")?.addEventListener("input", (ev) => {
    onEnsure(materialId);
    applyCommand(session, commands.updateMaterial(materialId, { color: ev.target.value }));
    afterShellCommand();
  });
  el.inspector.querySelector("#insp-texture")?.addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const url = await readFileAsDataUrl(file);
    onEnsure(materialId);
    applyCommand(session, commands.updateMaterial(materialId, { textureUrl: url }));
    afterShellCommand();
  });
  el.inspector.querySelector("#insp-clear-tex")?.addEventListener("click", () => {
    onEnsure(materialId);
    applyCommand(session, commands.updateMaterial(materialId, { textureUrl: null }));
    afterShellCommand();
  });
  void mat;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function setViewModeButtons(mode) {
  for (const btn of document.querySelectorAll(".mode")) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  }
}

function doUndo() {
  if (!canUndo(session)) return;
  undo(session);
  plan2d.redraw();
  view3d.rebuild();
  persistQuiet();
  updateUndoButtons();
  renderInspector();
  setStatus("Undo");
}

function doRedo() {
  if (!canRedo(session)) return;
  redo(session);
  plan2d.redraw();
  view3d.rebuild();
  persistQuiet();
  updateUndoButtons();
  renderInspector();
  setStatus("Redo");
}

function replaceProjectDoc(doc) {
  resetSession(session, doc);
  localGltfProvider.syncFromDocAssets(session.doc.assets);
  shellSelection = null;
  selectedAssetId = null;
  plan2d.setSession(session);
  plan2d.setSelection({ kind: null, id: null });
  plan2d.fitView();
  view3d.setSelection(null);
  view3d.setMode("orbit");
  setViewModeButtons("orbit");
  view3d.rebuild();
  view3d.focusExtents();
  persistQuiet();
  setShellTool(TOOLS.SELECT);
  renderCatalog();
  renderInspector();
  updateUndoButtons();
}

function newProject() {
  if (!confirm("Start a blank project? Unsaved changes stay only if you already saved JSON.")) return;
  replaceProjectDoc(createBlankProject({ name: "Untitled" }));
  setStatus("New blank project");
}

async function loadJsonFile(file) {
  const doc = await loadProjectFile(file);
  replaceProjectDoc(doc);
  setStatus(`Loaded ${session.doc.project?.name || "project"}`);
}

function loadStarterTemplate(templateId) {
  const template = getStarterTemplate(templateId);
  if (!template) return;
  const ok = confirm(`Load “${template.label}”? This will discard unsaved changes in the current project.`);
  if (!ok) return;
  replaceProjectDoc(template.doc);
  setStatus(`Loaded template: ${template.label}`);
}

async function importGlbFile(file) {
  try {
    const asset = await localGltfProvider.importFile(file);
    if (!getAsset(session.doc, asset.id)) {
      applyCommand(session, commands.addAsset({ ...asset }));
    }
    selectedAssetId = asset.id;
    setShellTool("furniture");
    afterShellCommand();
    renderCatalog();
    highlightCatalog();
    el.furnitureHint.textContent = `Imported “${asset.label}” — click the plan to place.`;
    setStatus(`Imported ${asset.label}`);
  } catch (err) {
    console.error(err);
    setStatus(err.message || "GLB import failed");
  }
}

function deleteFurnitureSelection() {
  if (shellSelection?.kind !== "furniture" || !shellSelection.id) return false;
  applyCommand(session, commands.deleteFurniture(shellSelection.id));
  shellSelection = null;
  view3d.setSelection(null);
  afterShellCommand();
  setStatus("Deleted furniture");
  return true;
}

function rotateFurnitureSelection() {
  if (shellSelection?.kind !== "furniture" || !shellSelection.id) return false;
  const item = getFurniture(session.doc, shellSelection.id);
  if (!item) return false;
  const next = ((item.rot || 0) + 90) % 360;
  applyCommand(session, commands.updateFurniture(item.id, { rot: next }));
  afterShellCommand();
  view3d.setSelection({ kind: "furniture", id: item.id });
  view3d.setMode("edit");
  setStatus(`Rotated to ${next}°`);
  return true;
}

function clearSelection() {
  shellSelection = null;
  selectedAssetId = null;
  highlightCatalog();
  plan2d.setSelection({ kind: null, id: null });
  view3d.setSelection(null);
  if (shellTool === "furniture") {
    el.furnitureHint.textContent = "Select a catalog item, then click the plan.";
  }
  renderInspector();
}

// --- UI bindings -----------------------------------------------------------

el.toolGrid.addEventListener("click", (e) => {
  const btn = e.target.closest(".tool");
  if (!btn?.dataset.tool) return;
  setShellTool(btn.dataset.tool);
});

document.getElementById("btn-undo")?.addEventListener("click", doUndo);
document.getElementById("btn-redo")?.addEventListener("click", doRedo);
document.getElementById("btn-new")?.addEventListener("click", newProject);
document.getElementById("btn-save")?.addEventListener("click", () => {
  const name = downloadProject(session.doc);
  setStatus(`Saved ${name}`);
});
document.getElementById("btn-load")?.addEventListener("click", () => el.fileJson.click());
el.fileJson.addEventListener("change", async () => {
  const file = el.fileJson.files?.[0];
  el.fileJson.value = "";
  if (!file) return;
  try {
    await loadJsonFile(file);
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Load failed");
  }
});

document.getElementById("btn-import-glb")?.addEventListener("click", () => el.fileGlb.click());
el.fileGlb.addEventListener("change", async () => {
  const file = el.fileGlb.files?.[0];
  el.fileGlb.value = "";
  if (!file) return;
  await importGlbFile(file);
});

el.templateGrid?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-template-id]");
  if (!btn) return;
  loadStarterTemplate(btn.dataset.templateId);
});

document.querySelectorAll(".mode").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode || "orbit";
    view3d.setMode(mode);
    setViewModeButtons(mode);
  });
});

el.planCanvas.addEventListener("pointerdown", onPlanPointerDownCapture, true);

window.addEventListener("keydown", (e) => {
  const target = e.target;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  // plan2d already handles Ctrl+Z/Y when focused; buttons cover the rest.
  // Extra: Del/Esc/R for furniture when shell owns that selection.
  if (e.key === "Escape") {
    if (shellTool === "furniture" && selectedAssetId) {
      selectedAssetId = null;
      highlightCatalog();
      el.furnitureHint.textContent = "Select a catalog item, then click the plan.";
      e.preventDefault();
      return;
    }
    if (shellSelection?.kind === "furniture") {
      clearSelection();
      e.preventDefault();
    }
    return;
  }

  if (e.key === "Delete" || e.key === "Backspace") {
    if (deleteFurnitureSelection()) e.preventDefault();
    return;
  }

  if ((e.key === "r" || e.key === "R") && !mod) {
    // Prefer shell rotate when furniture selected; skip if view3d edit mode
    // already handles R to avoid double-rotate.
    if (shellSelection?.kind === "furniture" && view3d.getMode() !== "edit") {
      if (rotateFurnitureSelection()) e.preventDefault();
    } else if (shellSelection?.kind === "furniture" && view3d.getMode() === "edit") {
      // view3d handles R; still refresh inspector after a tick
      requestAnimationFrame(() => {
        persistQuiet();
        renderInspector();
      });
    }
  }

  void mod;
});

window.addEventListener("resize", () => {
  plan2d.resize();
  view3d.resize();
});

// Init
setShellTool(TOOLS.SELECT);
renderCatalog();
renderInspector();
updateUndoButtons();
plan2d.fitView();
view3d.resize();
view3d.focusExtents();
setStatus(session.doc.walls?.length ? "Restored last project" : "Blank project");
