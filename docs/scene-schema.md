# Scene + Animation Schema

The **scene schema** is the single, versioned contract shared by the frontend,
the backend, and the AI codegen agent. It describes an animated scene as:

- **objects** — drawable geometry + style (freehand strokes in v1),
- **per-object keyframes** — `{ t, props }` interpolated over time,
- **a camera track** — `{ t, center, zoom }` keyframes + output resolution,
- **timeline metadata** — `{ durationSeconds, fps }`,
- a top-level **`schemaVersion`**.

Authoritative definitions:

- Backend: [`backend/schema.py`](../backend/schema.py) (Pydantic v2).
- Frontend: [`frontend/src/types/scene.ts`](../frontend/src/types/scene.ts) (TypeScript).
- Example payload: [`agents/fixtures/example-scene.json`](../agents/fixtures/example-scene.json).

The two definitions are kept structurally identical. The wire format is JSON
with **camelCase** keys (`schemaVersion`, `durationSeconds`).

## Versioning

`schemaVersion` is currently `1.1.0`. It follows semver intent: bump the major
when a change is breaking. Consumers should reject a major version they do not
understand rather than silently mis-parsing. Schema changes ripple to every
downstream task (timeline, camera, agent, integration), so bump deliberately.

> **`1.1.0` (additive).** Adds object variants beyond freehand:
> `text`, `equation`, `line`, `arrow`, `rect`, `ellipse`, `triangle`
> (see [New object variants](#new-object-variants-110)). v1.0 payloads still
> validate unchanged; keyframes are shared across all variants.

## Top-level shape

```jsonc
{
  "schemaVersion": "1.0.0",
  "timeline": { "durationSeconds": 3.0, "fps": 30 },
  "camera": {
    "width": 1920,
    "height": 1080,
    "keyframes": [
      { "t": 0.0, "center": [960, 540], "zoom": 1.0 },
      { "t": 3.0, "center": [1400, 540], "zoom": 1.25 }
    ]
  },
  "objects": [ /* SceneObject[] */ ]
}
```

### Object: freehand stroke (v1)

```jsonc
{
  "id": "stroke-1",
  "type": "freehand",
  "points": [ { "x": 300, "y": 440 }, /* ...ordered... */ ],
  "style": { "color": "#1e1e1e", "width": 3, "opacity": 1.0 },
  "keyframes": [
    { "t": 0.0, "props": { "position": [0, 0],   "scale": 1, "rotation": 0, "opacity": 1 } },
    { "t": 3.0, "props": { "position": [900, 0], "scale": 1, "rotation": 0, "opacity": 1 } }
  ]
}
```

- `type` is a **discriminant**. `"freehand"` is the original variant; `1.1.0`
  adds `text`, `equation`, `line`, `arrow`, `rect`, `ellipse`, `triangle`
  (below), each with its own `type` literal and geometry fields. `points` /
  `style` are freehand-specific.
- `points` are **ordered** and in **canvas pixels (y-DOWN)**.

### New object variants (1.1.0)

All variants share `id`, a unique `type` literal, and a `keyframes` array using
the **same** `{ t, props }` shape as freehand (position delta / scale / rotation
/ opacity — no per-type keyframe shapes). All geometry is **canvas pixels,
y-DOWN**. `style` is the shared `StrokeStyle` (`color`, `width`, `opacity`).
Shape variants (`rect`, `ellipse`, `triangle`) also take an optional
`fill` (CSS color string, or `null`/omitted for unfilled).

The backend models this as a Pydantic v2 discriminated union on `type`
(`Field(discriminator="type")`); the frontend mirrors it as a TS union.

| `type` | Geometry fields | Extra fields | → Manim mobject |
| --- | --- | --- | --- |
| `text` | `position` `[x,y]` (top-left anchor) | `text`, `fontSize`, `color` | `Text` |
| `equation` | `position` `[x,y]` (top-left anchor) | `latex`, `fontSize`, `color` | `MathTex` (LaTeX) |
| `line` | `start` `[x,y]`, `end` `[x,y]` | `style` | `Line` |
| `arrow` | `start` `[x,y]` (tail), `end` `[x,y]` (head) | `style` | `Arrow` |
| `rect` | `position` `[x,y]` (top-left), `width`, `height` | `style`, `fill?` | `Rectangle` |
| `ellipse` | `center` `[x,y]`, `radiusX`, `radiusY` | `style`, `fill?` | `Ellipse` |
| `triangle` | `points` `[[x,y],[x,y],[x,y]]` (3 vertices) | `style`, `fill?` | `Polygon`/`Triangle` |

```jsonc
// text — top-left anchored; fontSize is in canvas px
{ "id": "t1", "type": "text", "position": [200, 160],
  "text": "Hello, Manim!", "fontSize": 48, "color": "#1e1e1e", "keyframes": [] }

// equation — LaTeX (math mode); maps to MathTex
{ "id": "eq1", "type": "equation", "position": [200, 280],
  "latex": "E = mc^2", "fontSize": 56, "color": "#1864ab", "keyframes": [] }

// line / arrow — two endpoints + StrokeStyle
{ "id": "l1", "type": "line",  "start": [200, 480], "end": [700, 480],
  "style": { "color": "#e03131", "width": 4, "opacity": 1.0 }, "keyframes": [] }
{ "id": "a1", "type": "arrow", "start": [200, 560], "end": [700, 560],
  "style": { "color": "#2f9e44", "width": 4, "opacity": 1.0 }, "keyframes": [] }

// rect — top-left + size; optional fill
{ "id": "r1", "type": "rect", "position": [900, 200], "width": 320, "height": 200,
  "style": { "color": "#1971c2", "width": 3, "opacity": 1.0 },
  "fill": "#a5d8ff", "keyframes": [] }

// ellipse — center + radii; fill null = unfilled
{ "id": "e1", "type": "ellipse", "center": [1400, 320], "radiusX": 160, "radiusY": 100,
  "style": { "color": "#9c36b5", "width": 3, "opacity": 1.0 },
  "fill": null, "keyframes": [] }

// triangle — three [x,y] vertices
{ "id": "tr1", "type": "triangle",
  "points": [[1000, 700], [1300, 700], [1150, 480]],
  "style": { "color": "#e8590c", "width": 3, "opacity": 1.0 },
  "fill": "#ffd8a8", "keyframes": [] }
```

**Codegen guidance (T6).** Apply the canvas→Manim transform below to each
variant's geometry just as for freehand points:
- `text`/`equation`: map `position` (top-left) to a world point, then anchor the
  mobject's top-left there (e.g. `.to_corner`/`.move_to` with `aligned_edge=UL`).
  `fontSize` is canvas px — scale to Manim font size / use `scale()` consistently
  with the px→units factor `s`. `equation` requires LaTeX provisioning; if LaTeX
  is unavailable, fall back to `Text` or skip per the note at the bottom.
- `line`/`arrow`: transform both endpoints; build `Line(p_start, p_end)` /
  `Arrow(p_start, p_end)`.
- `rect`: transform `position` to the top-left; `width`/`height` are scaled by
  `s` (note the y-flip means the rect still extends "down" in canvas → toward
  −y in Manim). Center the `Rectangle(width=w*s, height=h*s)` accordingly.
- `ellipse`: transform `center`; `Ellipse(width=2*radiusX*s, height=2*radiusY*s)`.
- `triangle`: transform the three vertices and build `Polygon(*verts)`.
- For filled shapes, set `set_fill(fill, opacity=...)`; for `fill` null/omitted,
  leave unfilled (`fill_opacity=0`).

### Keyframes and interpolation

- **Object keyframe** `{ t, props }`: `props` are all optional and declare only
  what changes — `position` (a `[dx, dy]` translation in canvas px from the
  authored geometry), `scale` (uniform), `rotation` (degrees, clockwise in the
  y-DOWN canvas), `opacity` (0..1 multiplier on the style opacity).
- **Camera keyframe** `{ t, center, zoom }`: `center` is the canvas-pixel point
  the frame is centered on; `zoom > 1` zooms in (frame covers less canvas).
- `t` is **seconds** from the start of the timeline, `0 <= t <= durationSeconds`.
  Keyframes are expected sorted by `t` ascending.
- **Interpolation is linear** between successive keyframes in v1. Before the
  first keyframe the value holds at the first; after the last it holds at the
  last (clamp/hold at the ends).

> **Extension point — easing.** Per-keyframe easing curves slot in as an
> optional `easing` field on `ObjectKeyframe` / `CameraKeyframe` (e.g.
> `"linear" | "easeInOut" | [cubic-bezier]`). Until then, assume linear.

## Canvas → Manim coordinate transform

The canvas and Manim use **different coordinate systems**, and getting this
wrong is a classic bug source. Define it once here; the camera UI (T5) and the
codegen agent (T6) both reuse it.

| | Canvas | Manim |
| --- | --- | --- |
| Units | pixels | scene units |
| X axis | right = + | right = + |
| Y axis | **down = +** | **up = +** |
| Origin | top-left `(0, 0)` | center of frame `(0, 0)` |

The mapping is driven by the camera frame. Manim's default `MovingCameraScene`
frame is **`FRAME_WIDTH = 14.222…` units wide** (`config.frame_width`,
`16/9 * 8`) and **`FRAME_HEIGHT = 8` units tall**, matching the 16:9 output.

We map the canvas so that the **camera frame at zoom 1** fills the Manim frame.
Let:

- `Wc`, `Hc` = output resolution (`camera.width`, `camera.height`), e.g.
  `1920 × 1080`.
- `FW`, `FH` = Manim frame size in units = `14.222…`, `8`.
- `s = FW / Wc` = `FH / Hc` = units-per-pixel scale (equal in x and y because
  the camera aspect is locked to the output aspect). For `1920×1080`:
  `s = 14.222… / 1920 = 0.0074074… units/px`.

For a **static** mapping (ignoring camera offset/zoom), a canvas point
`(px, py)` maps to Manim world units `(mx, my)`:

```
mx =  (px - Wc/2) * s
my = -(py - Hc/2) * s        # note the minus: y-down → y-up
```

The center of the canvas maps to the Manim origin; the **minus sign on `my`**
is the y-axis flip.

### Camera at a keyframe

The camera frame is centered on canvas point `center = (cx, cy)` with `zoom`.
Manim's camera is driven from the same transform:

```
frame_center_manim = ( (cx - Wc/2) * s, -(cy - Hc/2) * s )
frame_width_manim  = FW / zoom        # zoom > 1 ⇒ narrower frame ⇒ zoomed in
```

In Manim (`MovingCameraScene`): `self.camera.frame.move_to([fx, fy, 0])` and
`self.camera.frame.set(width=FW/zoom)` (or `.scale(1/zoom)` from the default).

### Worked numeric example

Using the fixture ([`example-scene.json`](../agents/fixtures/example-scene.json)),
`Wc=1920`, `Hc=1080`, so `s = 14.2222 / 1920 = 0.00740741 units/px`.

**Object position.** The stroke's first point is `(300, 440)`. At `t=0` its
keyframe `position` is `[0, 0]`, so the world position of that point:

```
mx = (300 - 960)  * 0.00740741 = (-660) * 0.00740741 = -4.889
my = -(440 - 540) * 0.00740741 = -(-100) * 0.00740741 =  0.741
→ (-4.889,  0.741)
```

At `t=3.0` the keyframe `position` is `[900, 0]`, so the same point's canvas
position is `(300+900, 440+0) = (1200, 440)`:

```
mx = (1200 - 960) * 0.00740741 = 240 * 0.00740741 =  1.778
my = -(440 - 540) * 0.00740741 =                     0.741
→ (1.778, 0.741)
```

So the stroke translates from `mx ≈ -4.889` to `mx ≈ +1.778` (a left→right
move of `+6.667` units) over 3 seconds, `y` unchanged — exactly the intended
left→right motion.

**Camera.** Camera keyframes:

```
t=0.0: center (960, 540), zoom 1.00
  fx = (960  - 960) * 0.00740741 = 0.000
  fy = -(540 - 540) * 0.00740741 = 0.000
  frame_width = 14.2222 / 1.00 = 14.2222         → centered, default zoom

t=3.0: center (1400, 540), zoom 1.25
  fx = (1400 - 960) * 0.00740741 = 440 * 0.00740741 = 3.259
  fy = -(540  - 540) * 0.00740741 = 0.000
  frame_width = 14.2222 / 1.25 = 11.378           → pans right + zooms in
```

The camera pans from world `x=0` to `x≈3.259` and tightens the frame from
`14.222` to `11.378` units wide over the 3-second timeline — a rightward pan
with a slight zoom-in, matching the camera keyframes.

> The agent (T6) should apply this transform per-frame (or per-keyframe, since
> the mapping is affine and Manim interpolates linearly) when emitting
> `MovingCameraScene` code, and must avoid `Tex`/`MathTex` unless LaTeX is
> provisioned.
