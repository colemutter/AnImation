# ADR-001: Canvas rendering approach

- Status: Accepted
- Date: 2026-06-25
- Task: T1 (canvas foundation + freehand draw tool)

## Context

The app is an Excalidraw-style drawing surface: an infinite, pannable/zoomable
canvas with a floating tool palette and a freehand draw tool. Crucially, later
tasks layer on top of the canvas:

- **T4** — a custom **bottom timeline** bar with a scrubber.
- **T5** — a draggable/resizable **camera-rectangle overlay**, aspect-locked.
- **T2/T8** — programmatic **serialization** of every drawn object's geometry
  into the `Scene` schema (`frontend/src/types/scene.ts`), where a freehand
  stroke is an ordered list of canvas-pixel points + stroke style.

So the canvas layer is judged on three axes:

1. Can we render a custom bottom timeline and a camera-rectangle overlay that
   track the canvas coordinate system?
2. Can we read/write object geometry programmatically for serialization?
3. Hand-drawn aesthetic out of the box, with minimal total complexity.

## Options considered

### A. `@excalidraw/excalidraw`
- **Look:** Best out-of-the-box hand-drawn aesthetic (it is the reference).
- **Overlays:** The component owns its own viewport/scroll/zoom state. Drawing a
  *custom* camera rectangle that stays glued to scene coordinates means mirroring
  Excalidraw's internal scroll/zoom (`appState.scrollX/scrollY/zoom`) and
  reacting to every `onChange`. Doable but fiddly, and we'd be fighting a large,
  opinionated component for what is ultimately our own overlay layer.
- **Serialization:** Geometry is available via `onChange`/`getSceneElements`,
  but freehand strokes are Excalidraw `freedraw` elements with their own shape;
  we'd map them to our schema anyway.
- **Cost:** Large dependency; we adopt its whole UX and then partially hide it.

### B. `tldraw`
- **Look:** Clean, but not hand-drawn by default; would need styling work.
- **Overlays:** Very good, well-documented React API and a real editor model.
- **Serialization:** Strong — its store is queryable.
- **Cost:** Still a large editor framework and its own shape/coordinate model for
  what is, in v1, a single freehand tool plus our own overlays.

### C. Custom — `perfect-freehand` on a `<canvas>` + a `zustand` store (CHOSEN)
- **Look:** `perfect-freehand` produces smooth, pressure-style strokes; gives a
  pleasant hand-drawn feel. (`rough.js` can be added later for shapes/jitter when
  rect/line/text land — noted as an extension point.)
- **Overlays:** We own the single screen↔world transform (pan offset + zoom), so
  the bottom timeline and the camera rectangle are plain React/DOM elements
  positioned with that same transform. No framework internals to mirror.
- **Serialization:** The object model **is** the schema. Strokes are stored as
  `FreehandObject` (ordered `Point[]` + `StrokeStyle`) directly in the store, so
  `useSceneStore.getState().objects` already returns serialization-ready data —
  zero adapter code for T2/T8.
- **Cost:** We write the pan/zoom + pointer plumbing ourselves (~a few hundred
  lines), but avoid adopting and then partially hiding a large editor. Lowest
  *total* complexity given how overlay-heavy and serialization-driven the
  roadmap is.

## Decision

Adopt **Option C: a custom canvas** using `perfect-freehand` for stroke geometry
and `zustand` for the app state store.

The deciding factor is integration cost across the whole roadmap, not just T1.
T4 (timeline) and T5 (camera rectangle) are custom overlays that must read the
canvas coordinate system, and T2/T8 need first-class access to object geometry.
A custom canvas makes the coordinate transform explicit and ours, makes overlays
trivial DOM, and makes the store the single source of truth that already matches
the wire schema. The big libraries (`@excalidraw/excalidraw`, `tldraw`) optimize
for a rich editor we don't need yet, and would cost more to bend around our
overlays than the canvas plumbing costs to write.

## Consequences

- We maintain the pan/zoom + pointer code ourselves (see
  `frontend/src/canvas/CanvasStage.tsx`).
- The hand-drawn look is "good" rather than "pixel-perfect Excalidraw." If that
  becomes a requirement, `rough.js` can be layered in for shapes, or this ADR can
  be revisited to migrate to Excalidraw.
- Object geometry maps 1:1 to `frontend/src/types/scene.ts` (`FreehandObject`),
  so serialization is free.
- Clearly marked extension points are left for the T4 timeline and T5 camera
  overlay (search for `EXTENSION POINT` in `frontend/src/`).

## Fallback

If the custom canvas later blocks a needed editor feature (multi-select,
rotation handles, text editing) more cheaply solved by a library, fall back to
`@excalidraw/excalidraw` (best look) and reconcile its element model with the
schema in an adapter. This ADR should be superseded rather than edited.
