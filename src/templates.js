/**
 * Starter apartment shells. Generic, metric, and grid-aligned.
 */

const BASE_MATERIALS = [
  { id: "mat_wall", color: "#d7d2c8" },
  { id: "mat_floor", color: "#2e3631" },
];

function baseProject(name) {
  return {
    version: 1,
    project: {
      name,
      units: "m",
      grid: 0.1,
      wallDefaults: {
        thicknessInterior: 0.1,
        thicknessExterior: 0.25,
        height: 2.6,
      },
    },
    levels: [{ id: "level_ground", name: "Level 1", z: 0 }],
    walls: [],
    floors: [{ id: "floor_main", x: 0, y: 0, w: 6, d: 5, materialId: "mat_floor" }],
    stairs: [],
    furniture: [],
    materials: BASE_MATERIALS.map((m) => ({ ...m })),
    assets: [],
  };
}

const EMPTY_DOC = baseProject("Empty");

const STUDIO_DOC = {
  ...baseProject("Studio shell"),
  walls: [
    {
      id: "wall_st_1",
      x0: 0, y0: 0, x1: 6, y1: 0,
      thickness: 0.25, height: 2.6, materialId: "mat_wall",
      openings: [{ id: "door_st_1", type: "door", along: 2.5, width: 0.9, height: 2.1, sill: 0 }],
    },
    {
      id: "wall_st_2",
      x0: 6, y0: 0, x1: 6, y1: 5,
      thickness: 0.25, height: 2.6, materialId: "mat_wall",
      openings: [{ id: "win_st_1", type: "window", along: 1.6, width: 1.4, height: 1.2, sill: 0.9 }],
    },
    {
      id: "wall_st_3",
      x0: 6, y0: 5, x1: 0, y1: 5,
      thickness: 0.25, height: 2.6, materialId: "mat_wall",
      openings: [{ id: "win_st_2", type: "window", along: 2.2, width: 1.2, height: 1.2, sill: 0.9 }],
    },
    {
      id: "wall_st_4",
      x0: 0, y0: 5, x1: 0, y1: 0,
      thickness: 0.25, height: 2.6, materialId: "mat_wall",
      openings: [],
    },
  ],
};

const T1_DOC = {
  ...baseProject("T1 shell"),
  floors: [{ id: "floor_main", x: 0, y: 0, w: 8, d: 6, materialId: "mat_floor" }],
  walls: [
    { id: "wall_t1_1", x0: 0, y0: 0, x1: 8, y1: 0, thickness: 0.25, height: 2.6, materialId: "mat_wall", openings: [{ id: "door_t1_entry", type: "door", along: 1.8, width: 0.9, height: 2.1, sill: 0 }] },
    { id: "wall_t1_2", x0: 8, y0: 0, x1: 8, y1: 6, thickness: 0.25, height: 2.6, materialId: "mat_wall", openings: [{ id: "win_t1_1", type: "window", along: 1.4, width: 1.4, height: 1.2, sill: 0.9 }] },
    { id: "wall_t1_3", x0: 8, y0: 6, x1: 0, y1: 6, thickness: 0.25, height: 2.6, materialId: "mat_wall", openings: [{ id: "win_t1_2", type: "window", along: 2.2, width: 1.4, height: 1.2, sill: 0.9 }] },
    { id: "wall_t1_4", x0: 0, y0: 6, x1: 0, y1: 0, thickness: 0.25, height: 2.6, materialId: "mat_wall", openings: [] },
    { id: "wall_t1_5", x0: 4, y0: 0, x1: 4, y1: 6, thickness: 0.1, height: 2.6, materialId: "mat_wall", openings: [{ id: "door_t1_inner", type: "door", along: 2.2, width: 0.8, height: 2.1, sill: 0 }] },
  ],
};

const T2_DOC = {
  ...baseProject("T2 shell"),
  floors: [{ id: "floor_main", x: 0, y: 0, w: 10, d: 7, materialId: "mat_floor" }],
  walls: [
    { id: "wall_t2_1", x0: 0, y0: 0, x1: 10, y1: 0, thickness: 0.25, height: 2.6, materialId: "mat_wall", openings: [{ id: "door_t2_entry", type: "door", along: 2.4, width: 0.9, height: 2.1, sill: 0 }] },
    { id: "wall_t2_2", x0: 10, y0: 0, x1: 10, y1: 7, thickness: 0.25, height: 2.6, materialId: "mat_wall", openings: [{ id: "win_t2_1", type: "window", along: 1.5, width: 1.5, height: 1.2, sill: 0.9 }] },
    { id: "wall_t2_3", x0: 10, y0: 7, x1: 0, y1: 7, thickness: 0.25, height: 2.6, materialId: "mat_wall", openings: [{ id: "win_t2_2", type: "window", along: 2.3, width: 1.6, height: 1.2, sill: 0.9 }] },
    { id: "wall_t2_4", x0: 0, y0: 7, x1: 0, y1: 0, thickness: 0.25, height: 2.6, materialId: "mat_wall", openings: [{ id: "win_t2_3", type: "window", along: 2, width: 1.2, height: 1.2, sill: 0.9 }] },
    { id: "wall_t2_5", x0: 3.6, y0: 0, x1: 3.6, y1: 7, thickness: 0.1, height: 2.6, materialId: "mat_wall", openings: [{ id: "door_t2_a", type: "door", along: 2.1, width: 0.8, height: 2.1, sill: 0 }] },
    { id: "wall_t2_6", x0: 6.8, y0: 0, x1: 6.8, y1: 7, thickness: 0.1, height: 2.6, materialId: "mat_wall", openings: [{ id: "door_t2_b", type: "door", along: 4.3, width: 0.8, height: 2.1, sill: 0 }] },
    { id: "wall_t2_7", x0: 3.6, y0: 3.2, x1: 10, y1: 3.2, thickness: 0.1, height: 2.6, materialId: "mat_wall", openings: [{ id: "door_t2_c", type: "door", along: 2.1, width: 0.8, height: 2.1, sill: 0 }] },
  ],
};

export const STARTER_TEMPLATES = Object.freeze([
  { id: "empty", label: "Empty", doc: EMPTY_DOC },
  { id: "studio-shell", label: "Studio shell", doc: STUDIO_DOC },
  { id: "t1-shell", label: "T1 shell", doc: T1_DOC },
  { id: "t2-shell", label: "T2 shell", doc: T2_DOC },
]);

export function getStarterTemplate(id) {
  return STARTER_TEMPLATES.find((template) => template.id === id) || null;
}
