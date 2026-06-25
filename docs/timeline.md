# Timeline, Keyframes & Interpolation (T4)

The timeline drives **time-based preview** of the scene on the canvas. It owns a
playhead time (`currentTime`, seconds), a play/pause loop, and per-object
**keyframe capture** — all kept in the exact scene-schema shape
(`frontend/src/types/scene.ts`) so serialization for the agent/backend stays
trivial.

## Data model (no parallel model)

Keyframes live where the schema already puts them: on each object's
`keyframes: ObjectKeyframe[]`. An `ObjectKeyframe` is:

```ts
{ t: number, props: { position?: [dx, dy], scale?, rotation?, opacity? } }
```

- **`t`** — seconds from the start of the timeline, `0 <= t <= durationSeconds`.
- **`props`** are applied on top of the object's **authored** geometry/style:
  - `position` — `[dx, dy]` translation in canvas px from the authored points.
  - `scale` — uniform multiplier about the stroke centroid (1 = original).
  - `rotation` — degrees, clockwise in the y-DOWN canvas, about the centroid.
  - `opacity` — 0..1 multiplier on the style's base opacity.

Every field is optional; a keyframe declares only what it changes. Timeline
metadata (`durationSeconds`, `fps`) lives in the store and mirrors
`Timeline` from the schema.

## Interpolation (`frontend/src/timeline/interpolate.ts`)

Pure, React-free, unit-testable functions:

- `interpolateKeyframes(keyframes, t) -> ResolvedTransform` — resolves the full
  `{ position, scale, rotation, opacity }` at time `t`. **Linear** between
  successive keyframes (v1, per `docs/scene-schema.md`); **hold/clamp** before
  the first and after the last. Each prop is resolved independently, skipping
  keyframes that don't declare it (an `opacity`-only keyframe doesn't disturb
  `position` interpolation).
- `upsertKeyframe(keyframes, t, props) -> ObjectKeyframe[]` — the shared capture
  primitive. Inserts a new keyframe at `t` or **merges** `props` into the
  keyframe already at (≈) that time, returning a new sorted array. T5's camera
  reuses this exact upsert pattern on its own keyframe array.
- Objects with **no keyframes** resolve to the identity transform, i.e. they
  render exactly at their authored position.

## Capture (how moving an object records a keyframe)

With the **Select** tool (`V`):

1. Pointer-down hit-tests the object under the cursor (against its *resolved*
   position at `currentTime`) and calls `beginObjectDrag(id)`.
2. Pointer-move accumulates a world-space delta via `dragObjectBy(dx, dy)`.
   While dragging, the canvas adds this live delta on top of the resolved
   transform so the object follows the cursor without yet writing a keyframe.
3. Pointer-up calls `endObjectDrag()`, which computes the committed
   `position = resolvedPositionAt(currentTime) + dragDelta` and upserts a
   **position keyframe at `currentTime`**.

Setting the object at two different playhead times therefore creates two
keyframes; scrubbing between them moves the object linearly.

`captureKeyframe(id, t, props)` is the generic store action behind this — drag
uses it for `position`, and `scale` / `rotation` / `opacity` can be captured
through the same path (same upsert, different props) when UI for them lands.

## Preview & playback

- **Scrub:** dragging the playhead sets `currentTime`; `CanvasStage` re-renders
  every object via `interpolateKeyframes(obj.keyframes, currentTime)`, applying
  the transform as an SVG wrapper `transform` (translate to keyframe position,
  then rotate/scale about the centroid) plus group `opacity`.
- **Play/pause:** the loop (`Timeline.tsx`, `requestAnimationFrame`) advances
  `currentTime` by real elapsed seconds and **loops** at `durationSeconds`, so
  the same interpolated render animates over time.
- **Keyframe dots:** the track shows diamond markers at each keyframe `t` for
  the selected object (or all objects when nothing is selected).

## Files

- `frontend/src/timeline/interpolate.ts` — pure interpolation + upsert utils.
- `frontend/src/timeline/Timeline.tsx` — bottom bar, playhead, play loop, dots.
- `frontend/src/store/sceneStore.ts` — timeline state + capture actions.
- `frontend/src/canvas/CanvasStage.tsx` — interpolated render + select/drag.

## Follow-ups (not in v1)

Per-keyframe easing (an optional `easing` field), a richer keyframe-track UI,
multi-select, and explicit scale/rotation/opacity capture handles.
