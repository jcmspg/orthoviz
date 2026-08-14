# OrthoViz

**Local-first orthogonal apartment / floor-plan builder with live 3D.**

Draw axis-aligned floor plans in the browser, see them update instantly in 3D, paint materials, place furniture, and export your project as JSON — no account, no cloud required.

## Features

- **Walls** — draw orthogonal (90°) walls on a metric grid (10 cm snap)
- **Doors & windows** — cut openings into walls
- **Floors & stairs** — room slabs and stair volumes
- **Materials** — colors and textures via the inspector
- **Furniture** — built-in primitives plus **GLB / glTF import**
- **Undo / redo** — full command history
- **Save / load** — download or restore JSON; last project also auto-saves locally in the browser

## Run locally

Needs network once (Three.js from unpkg). From the project folder:

```bash
py -m http.server 8765
```

Or:

```bash
python -m http.server 8765
```

Open [http://localhost:8765/](http://localhost:8765/)

## Quick start

1. Choose **Wall**, **Door**, **Window**, **Floor**, or **Stair** and draw on the 2D plan
2. Use **Select** to move items; **Del** deletes; the inspector edits thickness, color, and texture
3. Pick a furniture catalog item (or **Import GLB**), then click the plan to place; **R** rotates 90°; use **Edit** mode for 3D gizmos
4. **Save JSON** / **Load JSON** to export or restore a project

Units are meters. Projects start blank — build any layout you need.

## Tech stack

- Vanilla JavaScript ES modules (no build step)
- [Three.js](https://threejs.org/) for the live 3D view
- Canvas 2D for the plan editor
- Browser localStorage / IndexedDB for auto-save

## Product direction

OrthoViz is designed as a **local-first** tool today: open the folder, serve static files, work offline after the first Three.js load. No login. The architecture is intentionally simple and portable so the same core can grow into a hosted product later (cloud sync, teams, templates) without rewriting the modeling loop.

## License

Use and adapt for your own projects. Contributions and feedback welcome.