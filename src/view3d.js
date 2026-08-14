/**
 * Three.js 3D viewport: extrude walls/floors/stairs, render furniture, furniture gizmos.
 * Walls are preview-only here — edit them in the 2D plan.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import {
  applyCommand,
  cmdMoveFurniture,
  extents,
  getAsset,
  getFurniture,
  getMaterial,
  getProjectGrid,
  snapToGrid,
  wallLength,
} from "./model.js";
import { getAssetBlob } from "./persist.js";
import { PRIMITIVES } from "./assets.js";

const FLOOR_THICKNESS = 0.04;
const EPS = 1e-6;

const HANDLE = 0xc45c26;
const SCALE = 0xe0a21a;
const ROTATE = 0xe8c547;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ doc: object, undoStack: object[], redoStack: object[] }} session
 * @param {{
 *   onSelect?: (sel: object | null) => void,
 *   background?: number,
 * }} [options]
 */
export function createView3D(canvas, session, options = {}) {
  if (!canvas) throw new Error("createView3D requires a canvas");
  if (!session?.doc) throw new Error("createView3D requires a session");

  const onSelect = options.onSelect || (() => {});
  const bg = options.background ?? 0x1a221e;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(bg);

  const perspective = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
  perspective.position.set(6, 5, 8);

  const topCam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.05, 200);
  topCam.position.set(0, 20, 0);
  topCam.up.set(0, 0, -1);
  topCam.lookAt(0, 0, 0);

  let camera = perspective;
  let mode = "orbit"; // orbit | edit | top

  const controls = new OrbitControls(perspective, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 1, 0);
  controls.maxPolarAngle = Math.PI * 0.49;

  const hemi = new THREE.HemisphereLight(0xe8efe8, 0x3a4038, 0.85);
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.05);
  sun.position.set(4, 10, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 40;
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  scene.add(hemi, sun);

  const root = new THREE.Group();
  const wallGroup = new THREE.Group();
  const floorGroup = new THREE.Group();
  const stairGroup = new THREE.Group();
  const furnGroup = new THREE.Group();
  const gizmoGroup = new THREE.Group();
  const helperGroup = new THREE.Group();
  root.add(floorGroup, wallGroup, stairGroup, furnGroup, gizmoGroup, helperGroup);
  scene.add(root);

  const wallMeshes = new Map();
  const furnMeshes = new Map();
  /** @type {Map<string, THREE.Material>} */
  const materialCache = new Map();
  /** @type {Map<string, Promise<THREE.Object3D | null>>} */
  const glbCache = new Map();
  /** @type {Map<string, Promise<THREE.Texture | null>>} */
  const textureCache = new Map();
  let rebuildGen = 0;

  const textureLoader = new THREE.TextureLoader();
  const gltfLoader = new GLTFLoader();

  const doorMat = new THREE.MeshStandardMaterial({
    color: 0x5c4030,
    roughness: 0.7,
  });
  doorMat.userData.shared = true;
  const winMat = new THREE.MeshStandardMaterial({
    color: 0x88b8c8,
    roughness: 0.2,
    metalness: 0.1,
    transparent: true,
    opacity: 0.45,
  });
  winMat.userData.shared = true;
  const stairMat = new THREE.MeshStandardMaterial({
    color: 0x8a8178,
    roughness: 0.8,
  });
  stairMat.userData.shared = true;
  const handleMat = new THREE.MeshStandardMaterial({
    color: HANDLE,
    roughness: 0.5,
    depthTest: false,
  });
  handleMat.userData.shared = true;
  const scaleMat = new THREE.MeshStandardMaterial({
    color: SCALE,
    roughness: 0.5,
    depthTest: false,
  });
  scaleMat.userData.shared = true;
  const rotateMat = new THREE.MeshStandardMaterial({
    color: ROTATE,
    roughness: 0.5,
    depthTest: false,
  });
  rotateMat.userData.shared = true;

  /** @type {{ kind: string, id: string } | null} */
  let selection = null;
  let disposed = false;
  let raf = 0;

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();

  /** @type {object | null} */
  let drag = null;

  function clearGroup(group) {
    while (group.children.length) {
      const child = group.children[0];
      group.remove(child);
      child.traverse?.((o) => {
        if (o.geometry) o.geometry.dispose?.();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!m || m.userData?.shared) continue;
            m.map = null;
            m.dispose?.();
          }
        }
      });
    }
  }

  function hexColor(hex, fallback = 0xcccccc) {
    if (typeof hex === "number") return hex;
    if (typeof hex !== "string") return fallback;
    const n = Number.parseInt(hex.replace("#", ""), 16);
    return Number.isFinite(n) ? n : fallback;
  }

  function resolveMaterial(materialId, fallbackHex = "#d7d2c8") {
    const matDoc = materialId ? getMaterial(session.doc, materialId) : null;
    const color = matDoc?.color ?? fallbackHex;
    const textureUrl = matDoc?.textureUrl || "";
    const key = `${materialId || "none"}|${color}|${textureUrl}`;
    let mat = materialCache.get(key);
    if (mat) return mat;

    mat = new THREE.MeshStandardMaterial({
      color: hexColor(color),
      roughness: 0.85,
    });
    mat.userData.shared = true;
    materialCache.set(key, mat);

    if (textureUrl) {
      let texPromise = textureCache.get(textureUrl);
      if (!texPromise) {
        texPromise = new Promise((resolve) => {
          textureLoader.load(
            textureUrl,
            (tex) => {
              tex.colorSpace = THREE.SRGBColorSpace;
              tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
              resolve(tex);
            },
            undefined,
            () => resolve(null),
          );
        });
        textureCache.set(textureUrl, texPromise);
      }
      texPromise.then((tex) => {
        if (disposed || !tex) return;
        mat.map = tex;
        mat.needsUpdate = true;
      });
    }
    return mat;
  }

  function disposeMaterialCache() {
    for (const mat of materialCache.values()) {
      mat.map = null;
      mat.dispose?.();
    }
    materialCache.clear();
    for (const entry of textureCache.values()) {
      Promise.resolve(entry).then((tex) => tex?.dispose?.());
    }
    textureCache.clear();
  }

  function primitiveMeta(assetId) {
    return PRIMITIVES.find((p) => p.id === assetId) || null;
  }

  function assetSize(asset) {
    if (!asset) return { w: 0.6, d: 0.6, h: 0.6 };
    return {
      w: asset.w ?? 0.6,
      d: asset.d ?? 0.6,
      h: asset.h ?? 0.6,
    };
  }

  function buildWall(wall) {
    const len = wallLength(wall) || 0.001;
    const ang = Math.atan2(wall.y1 - wall.y0, wall.x1 - wall.x0);
    const h = wall.height ?? session.doc.project?.wallDefaults?.height ?? 2.6;
    const t = wall.thickness ?? 0.1;
    const mat = resolveMaterial(wall.materialId, "#d7d2c8");
    const opens = [...(wall.openings || [])].sort((a, b) => a.along - b.along);

    const group = new THREE.Group();
    group.userData = { kind: "wall", id: wall.id };

    let cursor = 0;
    const addSeg = (from, to) => {
      const segLen = to - from;
      if (segLen < 0.015) return;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(segLen, h, t), mat);
      mesh.position.set(from + segLen / 2 - len / 2, h / 2, 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { kind: "wall", id: wall.id };
      group.add(mesh);
    };

    for (const o of opens) {
      const a = Math.max(0, o.along);
      const b = Math.min(len, o.along + o.width);
      if (b <= a) continue;
      addSeg(cursor, a);
      const oh = o.height ?? 2.1;
      const sill = o.sill ?? 0;
      const midX = (a + b) / 2 - len / 2;
      const span = b - a;

      if (o.type === "window") {
        if (sill > 0.02) {
          const under = new THREE.Mesh(new THREE.BoxGeometry(span, sill, t), mat);
          under.position.set(midX, sill / 2, 0);
          under.userData = { kind: "wall", id: wall.id };
          group.add(under);
        }
        const aboveH = Math.max(0.02, h - sill - oh);
        const above = new THREE.Mesh(new THREE.BoxGeometry(span, aboveH, t), mat);
        above.position.set(midX, sill + oh + aboveH / 2, 0);
        above.userData = { kind: "wall", id: wall.id };
        group.add(above);
        const glass = new THREE.Mesh(
          new THREE.BoxGeometry(span, oh, t * 0.2),
          winMat,
        );
        glass.position.set(midX, sill + oh / 2, 0);
        glass.userData = { kind: "opening", id: o.id, wallId: wall.id };
        group.add(glass);
      } else {
        const aboveH = Math.max(0.02, h - oh);
        const above = new THREE.Mesh(new THREE.BoxGeometry(span, aboveH, t), mat);
        above.position.set(midX, oh + aboveH / 2, 0);
        above.userData = { kind: "wall", id: wall.id };
        group.add(above);
        const leaf = new THREE.Mesh(
          new THREE.BoxGeometry(span, oh, t * 0.15),
          doorMat,
        );
        leaf.position.set(midX, oh / 2, t * 0.25);
        leaf.userData = { kind: "opening", id: o.id, wallId: wall.id };
        group.add(leaf);
      }
      cursor = b;
    }
    addSeg(cursor, len);

    group.position.set((wall.x0 + wall.x1) / 2, 0, (wall.y0 + wall.y1) / 2);
    group.rotation.y = -ang;
    wallGroup.add(group);
    wallMeshes.set(wall.id, group);
  }

  function buildFloor(floor) {
    const mat = resolveMaterial(floor.materialId, "#2e3631");
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(floor.w, FLOOR_THICKNESS, floor.d),
      mat,
    );
    mesh.position.set(
      floor.x + floor.w / 2,
      -FLOOR_THICKNESS / 2,
      floor.y + floor.d / 2,
    );
    mesh.receiveShadow = true;
    mesh.userData = { kind: "floor", id: floor.id };
    floorGroup.add(mesh);
  }

  function buildStair(stair) {
    const steps = Math.max(1, Math.round(stair.steps || 12));
    const stepH = (stair.height || 2.6) / steps;
    const stepD = stair.d / steps;
    const group = new THREE.Group();
    group.userData = { kind: "stair", id: stair.id };

    for (let i = 0; i < steps; i++) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(stair.w, stepH, stepD),
        stairMat,
      );
      mesh.position.set(
        stair.x + stair.w / 2,
        i * stepH + stepH / 2,
        stair.y + i * stepD + stepD / 2,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { kind: "stair", id: stair.id };
      group.add(mesh);
    }
    stairGroup.add(group);
  }

  function makePrimitiveMesh(asset, colorHex) {
    const { w, d, h } = assetSize(asset);
    const mat = new THREE.MeshStandardMaterial({
      color: hexColor(colorHex || "#7a8f84"),
      roughness: 0.75,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    body.position.y = h / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    return body;
  }

  async function loadGlbRoot(asset) {
    const key = asset.src || asset.id;
    if (glbCache.has(key)) return glbCache.get(key);

    const promise = (async () => {
      try {
        const buffer = await getAssetBlob(key);
        if (!buffer) return null;
        const gltf = await new Promise((resolve, reject) => {
          gltfLoader.parse(
            buffer,
            "",
            (g) => resolve(g),
            (err) => reject(err),
          );
        });
        const rootObj = gltf.scene || gltf.scenes?.[0];
        if (!rootObj) return null;
        rootObj.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
              if (m) m.userData.shared = true;
            }
          }
        });
        // Normalize: sit on floor, center XZ, fit catalog w/d/h if present.
        const box = new THREE.Box3().setFromObject(rootObj);
        const size = new THREE.Vector3();
        box.getSize(size);
        const center = new THREE.Vector3();
        box.getCenter(center);
        rootObj.position.x -= center.x;
        rootObj.position.z -= center.z;
        rootObj.position.y -= box.min.y;
        const { w, d, h } = assetSize(asset);
        if (size.x > EPS && size.y > EPS && size.z > EPS) {
          const sx = w / size.x;
          const sy = h / size.y;
          const sz = d / size.z;
          rootObj.scale.set(sx, sy, sz);
        }
        return rootObj;
      } catch (err) {
        console.warn("Failed to load GLB asset", asset.id, err);
        return null;
      }
    })();

    glbCache.set(key, promise);
    return promise;
  }

  function applyFurnitureTransform(group, item, size) {
    group.position.set(item.x, 0, item.y);
    group.rotation.y = THREE.MathUtils.degToRad(-(item.rot || 0));
    group.scale.set(item.sx ?? 1, item.sz ?? 1, item.sy ?? 1);
    group.userData.size = size;
  }

  function buildFurniturePlaceholder(item, asset) {
    const meta = primitiveMeta(item.assetId) || primitiveMeta(asset?.id);
    const color = meta?.color || "#7a8f84";
    const body = makePrimitiveMesh(asset || meta || { w: 0.6, d: 0.6, h: 0.6 }, color);
    const group = new THREE.Group();
    group.userData = { kind: "furniture", id: item.id };
    body.userData = group.userData;
    group.add(body);
    applyFurnitureTransform(group, item, assetSize(asset || meta));
    furnGroup.add(group);
    furnMeshes.set(item.id, group);
  }

  async function buildFurniture(item, gen) {
    const asset = getAsset(session.doc, item.assetId) || primitiveMeta(item.assetId);
    if (!asset) {
      buildFurniturePlaceholder(item, null);
      return;
    }

    if (asset.kind === "glb") {
      buildFurniturePlaceholder(item, asset);
      const template = await loadGlbRoot(asset);
      if (disposed || gen !== rebuildGen) return;
      if (!getFurniture(session.doc, item.id)) return;

      const group = new THREE.Group();
      group.userData = { kind: "furniture", id: item.id };
      if (template) {
        const clone = template.clone(true);
        clone.traverse((o) => {
          if (!o.isMesh) return;
          o.userData = { kind: "furniture", id: item.id };
          // Clone materials so rebuild dispose does not poison the GLB cache.
          if (Array.isArray(o.material)) {
            o.material = o.material.map((m) => m.clone());
          } else if (o.material) {
            o.material = o.material.clone();
          }
        });
        group.add(clone);
      } else {
        const body = makePrimitiveMesh(asset, "#6b736c");
        body.userData = group.userData;
        group.add(body);
      }
      const live = getFurniture(session.doc, item.id);
      applyFurnitureTransform(group, live, assetSize(asset));
      const prev = furnMeshes.get(item.id);
      if (prev) {
        furnGroup.remove(prev);
        clearGroup(prev);
      }
      furnGroup.add(group);
      furnMeshes.set(item.id, group);
      if (selection?.kind === "furniture" && selection.id === item.id) {
        updateGizmo();
        highlightSelection();
      }
      return;
    }

    buildFurniturePlaceholder(item, asset);
  }

  function rebuildHelpers() {
    clearGroup(helperGroup);
    const ext = extents(session.doc);
    const pad = 2;
    const w = Math.max(4, ext.width + pad * 2);
    const d = Math.max(4, ext.depth + pad * 2);
    const cx = (ext.minX + ext.maxX) / 2 || 0;
    const cz = (ext.minY + ext.maxY) / 2 || 0;
    const divisions = Math.max(4, Math.ceil(Math.max(w, d)));
    const grid = new THREE.GridHelper(Math.ceil(Math.max(w, d)), divisions, 0x4a5850, 0x24302a);
    grid.position.set(cx, 0.001, cz);
    helperGroup.add(grid);
  }

  function rebuild() {
    rebuildGen += 1;
    const gen = rebuildGen;
    clearGroup(wallGroup);
    clearGroup(floorGroup);
    clearGroup(stairGroup);
    clearGroup(furnGroup);
    clearGroup(gizmoGroup);
    wallMeshes.clear();
    furnMeshes.clear();
    // Keep material / glb caches across rebuilds for speed.

    const doc = session.doc;
    for (const floor of doc.floors || []) buildFloor(floor);
    for (const wall of doc.walls || []) buildWall(wall);
    for (const stair of doc.stairs || []) buildStair(stair);
    for (const item of doc.furniture || []) {
      void buildFurniture(item, gen);
    }
    rebuildHelpers();
    updateGizmo();
    highlightSelection();
  }

  function furnitureFootprint(item) {
    const asset = getAsset(session.doc, item.assetId) || primitiveMeta(item.assetId);
    const size = assetSize(asset);
    const sx = item.sx ?? 1;
    const sy = item.sy ?? 1;
    return {
      w: size.w * sx,
      d: size.d * sy,
      h: size.h * (item.sz ?? 1),
    };
  }

  function updateGizmo() {
    clearGroup(gizmoGroup);
    if (mode !== "edit") return;
    if (selection?.kind !== "furniture") return;
    const item = getFurniture(session.doc, selection.id);
    if (!item) return;
    const fp = furnitureFootprint(item);
    const hw = fp.w / 2;
    const hd = fp.d / 2;
    const ang = THREE.MathUtils.degToRad(-(item.rot || 0));

    const move = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 0.04, 24),
      handleMat,
    );
    move.position.set(item.x, 0.06, item.y);
    move.renderOrder = 10;
    move.userData = { kind: "furn-move", id: item.id };
    gizmoGroup.add(move);

    const rotLocal = new THREE.Vector3(0, 0, -(hd + 0.35));
    rotLocal.applyAxisAngle(new THREE.Vector3(0, 1, 0), ang);
    const rot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 16), rotateMat);
    rot.position.set(item.x + rotLocal.x, 0.08, item.y + rotLocal.z);
    rot.renderOrder = 10;
    rot.userData = { kind: "furn-rotate", id: item.id };
    gizmoGroup.add(rot);

    for (const [sx, sz] of [
      [hw, hd],
      [-hw, hd],
      [hw, -hd],
      [-hw, -hd],
    ]) {
      const rx = sx * Math.cos(ang) - sz * Math.sin(ang);
      const rz = sx * Math.sin(ang) + sz * Math.cos(ang);
      const sc = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), scaleMat);
      sc.position.set(item.x + rx, 0.08, item.y + rz);
      sc.renderOrder = 10;
      sc.userData = { kind: "furn-scale", id: item.id };
      gizmoGroup.add(sc);
    }
  }

  function highlightSelection() {
    // Walls share materials — only furniture gets emissive selection feedback.
    for (const [id, g] of furnMeshes) {
      const selected = selection?.kind === "furniture" && selection.id === id;
      g.traverse((o) => {
        if (o.isMesh && o.material?.emissive) {
          o.material.emissive.setHex(selected ? 0x333018 : 0x000000);
        }
      });
    }
  }

  function normalizeSelection(sel) {
    if (!sel) return null;
    if (sel.kind === "furniture") {
      return { kind: "furniture", id: sel.id || sel.furnitureId };
    }
    if (sel.kind === "wall") {
      return { kind: "wall", id: sel.id || sel.wallId };
    }
    if (sel.kind === "opening") {
      return {
        kind: "opening",
        id: sel.id || sel.openingId,
        wallId: sel.wallId,
      };
    }
    if (sel.kind === "floor" || sel.kind === "stair") {
      return { kind: sel.kind, id: sel.id };
    }
    return null;
  }

  function setSelection(sel) {
    selection = normalizeSelection(sel);
    updateGizmo();
    highlightSelection();
    onSelect(selection);
  }

  function setMode(next) {
    mode = next === "edit" || next === "top" ? next : "orbit";
    if (mode === "top") {
      camera = topCam;
      controls.enabled = false;
      focusExtents();
    } else {
      camera = perspective;
      controls.enabled = !drag;
      controls.enableRotate = mode === "orbit";
    }
    updateGizmo();
  }

  function focusExtents() {
    const ext = extents(session.doc);
    const cx = (ext.minX + ext.maxX) / 2 || 0;
    const cz = (ext.minY + ext.maxY) / 2 || 0;
    const span = Math.max(ext.width, ext.depth, 4);
    controls.target.set(cx, 1, cz);
    if (camera === perspective) {
      const dist = span * 1.35;
      perspective.position.set(cx + dist * 0.65, dist * 0.7, cz + dist * 0.8);
      controls.update();
    } else {
      const half = span * 0.7;
      const aspect = camera.right / camera.top || 1;
      topCam.left = -half * aspect;
      topCam.right = half * aspect;
      topCam.top = half;
      topCam.bottom = -half;
      topCam.position.set(cx, 20, cz);
      topCam.lookAt(cx, 0, cz);
      topCam.updateProjectionMatrix();
    }
  }

  function resize() {
    const parent = canvas.parentElement;
    const w = parent?.clientWidth || canvas.clientWidth || 1;
    const h = parent?.clientHeight || canvas.clientHeight || 1;
    const aspect = w / Math.max(1, h);
    renderer.setSize(w, h, false);
    perspective.aspect = aspect;
    perspective.updateProjectionMatrix();
    const halfH = topCam.top;
    topCam.left = -halfH * aspect;
    topCam.right = halfH * aspect;
    topCam.updateProjectionMatrix();
  }

  function setPointer(ev) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
  }

  function floorHit() {
    raycaster.setFromCamera(pointer, camera);
    return raycaster.ray.intersectPlane(floorPlane, hitPoint) ? hitPoint.clone() : null;
  }

  function pick(ev) {
    setPointer(ev);
    raycaster.setFromCamera(pointer, camera);
    const targets = [...gizmoGroup.children, ...furnGroup.children, ...wallGroup.children];
    const hits = raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o && !o.userData?.kind) o = o.parent;
      if (o?.userData?.kind) return o.userData;
    }
    return null;
  }

  function syncFurnitureMesh(item) {
    const g = furnMeshes.get(item.id);
    if (!g) return;
    applyFurnitureTransform(g, item, g.userData.size || furnitureFootprint(item));
  }

  function commitFurnitureDrag() {
    if (!drag || !["furn-move", "furn-rotate", "furn-scale"].includes(drag.kind)) {
      drag = null;
      return;
    }
    const item = getFurniture(session.doc, drag.id);
    if (!item || !drag.orig) {
      drag = null;
      return;
    }
    const live = drag.live;
    const orig = drag.orig;
    const changed =
      live.x !== orig.x ||
      live.y !== orig.y ||
      live.rot !== orig.rot ||
      live.sx !== orig.sx ||
      live.sy !== orig.sy ||
      live.sz !== orig.sz;

    // Restore doc to pre-drag, then apply one undoable command with final values.
    Object.assign(item, orig);
    if (changed) {
      applyCommand(
        session,
        cmdMoveFurniture(item.id, {
          x: live.x,
          y: live.y,
          rot: live.rot,
          sx: live.sx,
          sy: live.sy,
          sz: live.sz,
        }),
      );
    }
    syncFurnitureMesh(getFurniture(session.doc, item.id));
    updateGizmo();
    drag = null;
    if (mode === "top") {
      controls.enabled = false;
    } else {
      controls.enabled = true;
      controls.enableRotate = mode === "orbit";
    }
  }

  function onPointerDown(ev) {
    if (disposed || ev.button !== 0) return;
    const ud = pick(ev);
    const p = floorHit();

    if (mode === "edit" && ud && String(ud.kind).startsWith("furn-")) {
      const item = getFurniture(session.doc, ud.id);
      if (!item) return;
      ev.preventDefault();
      controls.enabled = false;
      drag = {
        kind: ud.kind,
        id: item.id,
        orig: {
          x: item.x,
          y: item.y,
          rot: item.rot,
          sx: item.sx,
          sy: item.sy,
          sz: item.sz,
        },
        live: {
          x: item.x,
          y: item.y,
          rot: item.rot,
          sx: item.sx,
          sy: item.sy,
          sz: item.sz,
        },
      };
      if (ud.kind === "furn-move" && p) {
        drag.ox = item.x - p.x;
        drag.oy = item.y - p.z;
      }
      if (ud.kind === "furn-rotate" && p) {
        drag.startAngle = Math.atan2(p.z - item.y, p.x - item.x);
        drag.baseRot = item.rot || 0;
      }
      if (ud.kind === "furn-scale" && p) {
        drag.startDist = Math.hypot(p.x - item.x, p.z - item.y) || 0.01;
        drag.baseSx = item.sx ?? 1;
        drag.baseSy = item.sy ?? 1;
      }
      setSelection({ kind: "furniture", id: item.id });
      return;
    }

    if (mode === "edit" && ud?.kind === "furniture") {
      setSelection({ kind: "furniture", id: ud.id });
      if (p) {
        const item = getFurniture(session.doc, ud.id);
        if (item) {
          controls.enabled = false;
          drag = {
            kind: "furn-move",
            id: item.id,
            ox: item.x - p.x,
            oy: item.y - p.z,
            orig: {
              x: item.x,
              y: item.y,
              rot: item.rot,
              sx: item.sx,
              sy: item.sy,
              sz: item.sz,
            },
            live: {
              x: item.x,
              y: item.y,
              rot: item.rot,
              sx: item.sx,
              sy: item.sy,
              sz: item.sz,
            },
          };
        }
      }
      return;
    }

    if (ud?.kind === "furniture") {
      setSelection({ kind: "furniture", id: ud.id });
      return;
    }
    if (ud?.kind === "wall") {
      setSelection({ kind: "wall", id: ud.id });
      return;
    }
    if (ud?.kind === "opening") {
      setSelection({ kind: "opening", id: ud.id, wallId: ud.wallId });
      return;
    }
    setSelection(null);
  }

  function onPointerMove(ev) {
    if (!drag) return;
    setPointer(ev);
    const p = floorHit();
    if (!p) return;
    const item = getFurniture(session.doc, drag.id);
    if (!item) return;
    const grid = getProjectGrid(session.doc);

    if (drag.kind === "furn-move") {
      drag.live.x = snapToGrid(p.x + (drag.ox || 0), grid);
      drag.live.y = snapToGrid(p.z + (drag.oy || 0), grid);
      item.x = drag.live.x;
      item.y = drag.live.y;
    } else if (drag.kind === "furn-rotate") {
      const ang = Math.atan2(p.z - item.y, p.x - item.x);
      const delta = THREE.MathUtils.radToDeg(ang - drag.startAngle);
      let rot = Math.round(drag.baseRot + delta);
      rot = ((rot % 360) + 360) % 360;
      drag.live.rot = rot;
      item.rot = rot;
    } else if (drag.kind === "furn-scale") {
      const dist = Math.hypot(p.x - item.x, p.z - item.y) || 0.01;
      const scale = dist / drag.startDist;
      const sx = Math.max(0.1, Math.round(drag.baseSx * scale * 100) / 100);
      const sy = Math.max(0.1, Math.round(drag.baseSy * scale * 100) / 100);
      drag.live.sx = sx;
      drag.live.sy = sy;
      item.sx = sx;
      item.sy = sy;
    }
    syncFurnitureMesh(item);
    updateGizmo();
  }

  function onPointerUp() {
    if (!drag) return;
    commitFurnitureDrag();
  }

  function onKeyDown(ev) {
    if (mode !== "edit") return;
    if (ev.key === "r" || ev.key === "R") {
      if (selection?.kind !== "furniture") return;
      const item = getFurniture(session.doc, selection.id);
      if (!item) return;
      const next = ((item.rot || 0) + 90) % 360;
      applyCommand(session, cmdMoveFurniture(item.id, { rot: next }));
      syncFurnitureMesh(getFurniture(session.doc, item.id));
      updateGizmo();
    }
  }

  function tick() {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    if (controls.enabled) controls.update();
    renderer.render(scene, camera);
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKeyDown);

  function destroy() {
    disposed = true;
    cancelAnimationFrame(raf);
    canvas.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("keydown", onKeyDown);
    controls.dispose();
    clearGroup(wallGroup);
    clearGroup(floorGroup);
    clearGroup(stairGroup);
    clearGroup(furnGroup);
    clearGroup(gizmoGroup);
    clearGroup(helperGroup);
    disposeMaterialCache();
    glbCache.clear();
    doorMat.dispose();
    winMat.dispose();
    stairMat.dispose();
    handleMat.dispose();
    scaleMat.dispose();
    rotateMat.dispose();
    renderer.dispose();
  }

  resize();
  rebuild();
  focusExtents();
  tick();

  return {
    rebuild,
    setSelection,
    setMode,
    resize,
    destroy,
    focusExtents,
    /** @internal debugging / shell hooks */
    getSelection: () => selection,
    getMode: () => mode,
    getScene: () => scene,
    getCamera: () => camera,
  };
}
