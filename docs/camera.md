# Camera Viewport Indicator & Camera Keyframes (T5)

The **camera** is a draggable, resizable rectangle on the canvas that frames
what the final Manim animation will show. It is the on-canvas proxy for Manim's
`MovingCameraScene` `self.camera.frame`. Like objects, the camera is
**keyframe-animated**: keyframing its position/zoom at different timeline times
makes the camera pan and zoom over the animation.

## Model

State lives in the scene store (`frontend/src/store/sceneStore.ts`) and mirrors
the `Camera` / `CameraKeyframe` types in `frontend/src/types/scene.ts`:

```ts
cameraWidth: number          // output resolution width  (default 1920)
cameraHeight: number         // output resolution height (default 1080)
cameraCenter: [x, y]         // live frame center, canvas px (y-DOWN)
cameraZoom: number           // live zoom (> 1 = zoomed in / tighter frame)
cameraKeyframes: CameraKeyframe[]   // { t, center:[x,y], zoom }, sorted by t
```

`cameraCenter` / `cameraZoom` are the editable **base** (used when there are no
keyframes). Once keyframes exist, the displayed frame comes from interpolating
them at the playhead time.

### Aspect lock

The frame is **aspect-locked** to the output resolution
`cameraWidth / cameraHeight` (default `1920 / 1080 = 16:9`). Its world-space
size is always:

```
frameWidth  (canvas px) = cameraWidth  / zoom
frameHeight (canvas px) = cameraHeight / zoom
```

so `frameWidth / frameHeight === cameraWidth / cameraHeight` for any zoom.
Resizing only changes `zoom` (and `center`); the aspect can never drift. This
guarantees the frame maps cleanly onto Manim's fixed-aspect frame.

`zoom > 1` ⇒ a **smaller** frame ⇒ **zoomed in** (the frame covers less canvas),
matching `docs/scene-schema.md`.

## Rendering

`CameraOverlay` (`frontend/src/canvas/CameraOverlay.tsx`) renders the frame as an
SVG `<g>` mounted **inside the canvas world transform** in `CanvasStage` (at the
T5 extension point). Because it shares the world `translate(offset) scale(zoom)`
transform, the frame **pans and zooms with the scene** for free. Border, corner
handles and the `CAMERA` label are sized as `1/viewportZoom` so they keep a
constant on-screen weight as you zoom the canvas.

The frame interior stays click-through (so you can still draw inside it); grab
the **border** to move, or a **corner handle** to resize.

## Keyframe capture (reuses the T4 pattern)

Capture mirrors how T4 captures object keyframes (`endObjectDrag` → `upsertKeyframe`),
but on the camera's own array:

1. `beginCameraEdit()` — on pointer-down on the frame/handle. Seeds a live edit
   (`liveCamera`) from the **resolved** camera at `currentTime`, and pauses
   playback. The edit is therefore relative to wherever the frame currently sits.
2. `dragCamera({ center?, zoom? })` — on pointer-move. Body drag updates
   `center`; corner drag derives a new `zoom` from the pointer's distance to the
   fixed opposite corner (aspect stays locked by construction) and recomputes
   `center`. This only touches the uncommitted `liveCamera`.
3. `endCameraEdit()` — on pointer-up. Commits the live edit as a camera keyframe
   at `currentTime` via `upsertCameraKeyframe` (the mirror of `upsertKeyframe`:
   insert-or-replace at ≈`t`, keep sorted), and advances the live base.

Setting the camera at two different playhead times therefore creates two camera
keyframes; scrubbing between them pans/zooms the frame linearly.

## Interpolation & playback

`interpolateCameraKeyframes(keyframes, t, fallback)` (in `sceneStore.ts`) mirrors
the object `interpolateKeyframes`:

- **linear** between successive keyframes,
- **hold/clamp** before the first and after the last,
- falls back to the live base (`cameraCenter` / `cameraZoom`) when there are no
  keyframes.

During scrub and during the T4 play loop, `CameraOverlay` reads
`resolveCameraAt(currentTime)`, so the frame animates over time exactly like
objects do. While actively dragging, `resolveCameraAt` returns the live edit so
the frame follows the cursor.

## Mapping to Manim's `camera.frame`

The canvas→Manim transform is defined once in `docs/scene-schema.md`. With
`Wc, Hc = cameraWidth, cameraHeight`, Manim frame size `FW = 16/9 * 8 ≈ 14.222`,
`FH = 8`, and units-per-pixel `s = FW / Wc = FH / Hc`, a camera keyframe
`{ center: [cx, cy], zoom }` maps to:

```
frame_center_manim = ( (cx - Wc/2) * s, -(cy - Hc/2) * s )   # minus = y-flip
frame_width_manim  = FW / zoom                               # zoom>1 ⇒ narrower
```

In generated code (`MovingCameraScene`): `self.camera.frame.move_to([fx, fy, 0])`
and `self.camera.frame.set(width=FW/zoom)`. Because the aspect is locked to
`Wc/Hc` and Manim's frame is locked to `FW/FH = 16:9`, the frame width fully
determines the height — no separate height term is needed. The codegen agent (T6)
reads `cameraKeyframes` straight from the serialized scene and emits these calls
over the keyframe time windows.

## Serialization

The store's camera state serializes directly into the schema `Camera`:

```ts
const s = useSceneStore.getState()
const camera: Camera = {
  width: s.cameraWidth,
  height: s.cameraHeight,
  keyframes: s.cameraKeyframes,   // already in CameraKeyframe shape
}
```

## Follow-ups (not in v1)

- Show camera keyframe markers on the timeline track (T4's `Timeline` owns that
  component; skipped here to avoid touching T4's object-keyframe markers).
- A "camera view" preview thumbnail, multiple cameras, and per-keyframe easing.
