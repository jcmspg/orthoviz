/**
 * Image export helpers (local-first, no schema changes).
 */

function sanitizeBaseName(raw, fallback = "orthoviz") {
  const text = String(raw || "").trim().replace(/[^\w\-]+/g, "_");
  return text || fallback;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return filename;
}

function isCanvasLike(value) {
  return Boolean(value && typeof value === "object" && typeof value.width === "number" && typeof value.height === "number");
}

function resolveCanvas(input) {
  if (!input) throw new Error("Export source is required");
  if (isCanvasLike(input) && (typeof input.toBlob === "function" || typeof input.convertToBlob === "function")) {
    return input;
  }
  if (input.canvas && isCanvasLike(input.canvas)) return input.canvas;
  if (input.domElement && isCanvasLike(input.domElement)) return input.domElement;
  throw new Error("Could not resolve canvas from export source");
}

async function canvasToPngBlob(canvas) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/png" });
  }
  if (typeof canvas.toBlob !== "function") {
    throw new Error("Canvas does not support PNG export");
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Failed to encode PNG"));
    }, "image/png");
  });
}

/**
 * Export a plan canvas/offscreen canvas as PNG and trigger download.
 */
export async function exportPlanPng(planSource, options = {}) {
  const canvas = resolveCanvas(planSource);
  if (!canvas.width || !canvas.height) throw new Error("Plan canvas is empty");
  const base = sanitizeBaseName(options.projectName, "plan");
  const filename = options.filename || `${base}_plan.png`;
  const blob = await canvasToPngBlob(canvas);
  return downloadBlob(blob, filename);
}

/**
 * Export a Three.js renderer (or its canvas) as PNG and trigger download.
 */
export async function exportViewPng(viewSource, options = {}) {
  const canvas = resolveCanvas(viewSource);
  if (!canvas.width || !canvas.height) throw new Error("3D canvas is empty");
  const base = sanitizeBaseName(options.projectName, "view");
  const filename = options.filename || `${base}_3d.png`;
  const blob = await canvasToPngBlob(canvas);
  return downloadBlob(blob, filename);
}
