# AI Codegen Agent (T6): Scene JSON → Manim code

`POST /api/generate` takes a [scene payload](./scene-schema.md) (the same shape
as [`agents/fixtures/example-scene.json`](../agents/fixtures/example-scene.json))
and returns:

```json
{ "code": "<manim source>", "notes": "<short reasoning>" }
```

The generated `code` is a single `MovingCameraScene` subclass that the render
pipeline ([`backend/render.py`](../backend/render.py)) can execute directly. The
agent **only generates and statically validates** code; it never runs it.

Authoritative files:

- [`backend/agent.py`](../backend/agent.py) — `generate_manim(scene) -> {code, notes}`
  and the `POST /api/generate` wiring (`register_agent(app)`).
- [`backend/prompts/manim_system.txt`](../backend/prompts/manim_system.txt) —
  the system prompt that encodes all the domain rules.

## Model

- Default: **`claude-opus-4-8`** (`MODEL_DEFAULT`).
- Cheaper fallback: **`claude-sonnet-4-6`** (`MODEL_FALLBACK`), passable via the
  `model=` kwarg of `generate_manim`.

Model ids and SDK call shape were confirmed via the `/claude-api` skill (not from
memory). Uses the official `anthropic` Python SDK (`uv add anthropic`); no
hand-rolled HTTP. `ANTHROPIC_API_KEY` is read from the environment by
`anthropic.Anthropic()`.

## Structured output via forced tool use

Rather than scraping a code fence out of free text, the agent forces a clean
structured response. It defines one tool, `emit_manim`, with an
`input_schema` of `{code, notes}` and calls:

```python
client.messages.create(
    model="claude-opus-4-8",
    max_tokens=8000,
    system=<manim_system.txt>,          # system is a top-level kwarg
    tools=[EMIT_TOOL],
    tool_choice={"type": "tool", "name": "emit_manim"},  # forces the call
    messages=[{"role": "user", "content": <scene JSON + instructions>}],
)
```

The forced `tool_use` content block's `.input` is already a parsed dict, so we
read `code`/`notes` straight off it (`_extract_tool_result`).

## Prompt strategy

The system prompt (`manim_system.txt`) carries the domain knowledge so the user
turn is just the scene JSON. It pins, in order of importance:

1. **Hard render constraints** — exactly one class subclassing
   `MovingCameraScene`; `from manim import *`; valid importable Python with all
   logic in `construct`. **LaTeX is available** on the render host, so
   `equation` objects use `MathTex`; plain `text` still uses `Text(...)` (Pango).
2. **The coordinate transform** (see below) with an explicit `to_manim(px, py)`
   helper the model must emit and reuse for every point and camera center.
3. **The per-object-type Manim mapping** (see [Object type → Manim mobject](#object-type--manim-mobject)).
4. **The keyframe → animation mapping** (see below).
5. **Camera driving** from `camera.keyframes`.
6. **Freehand rendering** — a `VMobject` built with `set_points_smoothly` over
   the transformed stroke points.

## Object type → Manim mobject

Schema `1.1.0` adds object variants beyond `freehand`. The prompt maps each
`type` to a Manim mobject, applying the canvas→Manim transform (the `to_manim`
helper / px→units factor `s`) to ALL geometry, then drives its keyframes the
same way for every type.

| `type` | Geometry (canvas px, y-DOWN) | Manim mobject | Notes |
| --- | --- | --- | --- |
| `freehand` | `points` (via `STROKES`, see below) | `VMobject` + `set_points_smoothly` | only type using `STROKES` |
| `text` | `position` (top-left) | `Text(text, font_size=…)` | `.move_to(to_manim(pos), aligned_edge=UL)`; color from `color` |
| `equation` | `position` (top-left) | `MathTex(latex)` | LaTeX math source; size via `scale_to_fit_height(fontSize*s)`; color from `color` |
| `line` | `start`, `end` | `Line(to_manim(start), to_manim(end))` | stroke color/width/opacity from `style` |
| `arrow` | `start` (tail), `end` (head) | `Arrow(to_manim(start), to_manim(end), buff=0)` | stroke from `style` |
| `rect` | `position` (top-left), `width`, `height` | `Rectangle(width=w*s, height=h*s)` | centered at `(x+w/2, y+h/2)`; `fill` via `set_fill` |
| `ellipse` | `center`, `radiusX`, `radiusY` | `Ellipse(width=2*rx*s, height=2*ry*s)` | `.move_to(to_manim(center))`; `fill` via `set_fill` |
| `triangle` | `points` (3 vertices, **inline**) | `Polygon(*[to_manim(x,y) …])` | vertices inline in JSON, NOT in `STROKES`; `fill` via `set_fill` |

Stroke style (`color`/`width`/`opacity`) is applied to all stroked shapes
(freehand/line/arrow/rect/ellipse/triangle); canvas `width` is scaled down
(~`*0.6`, min ~1) for Manim units. Filled shapes (`rect`/`ellipse`/`triangle`)
call `set_fill(fill, opacity=1.0)` when `fill` is a color string and stay
unfilled (`fill_opacity=0`) when `fill` is null/omitted. Background stays WHITE.

### Freehand-only geometry stripping (important)

`_geometry_block` injects a module-level `STROKES` dict — but for **freehand
objects only** (freehand strokes can hold hundreds of points; transcribing them
as code literals risks truncating the module past `max_tokens`).
`_scene_to_user_message` correspondingly strips the `points` array **only when
`type == "freehand"`**, replacing it with a `STROKES[id]` placeholder.

All other types keep their geometry **inline** in the user message. This matters
for `triangle`, which also has a `points` field (its three `[x, y]` vertices):
those vertices are tiny and are NOT in `STROKES`, so they are left inline and the
model uses the numbers directly. (Stripping them would have pointed the model at
an undefined `STROKES[triangle_id]`.)

## LaTeX dependency

`equation` objects render via Manim's `MathTex`, which shells out to a LaTeX
toolchain. **The render host therefore requires LaTeX installed** — a TeX
distribution (e.g. **MacTeX** on macOS) plus **`dvisvgm`** — both on `PATH`.
Manim auto-detects them; no extra config is needed beyond having them installed.
`validate_code` no longer rejects `MathTex`/`Tex`. If the toolchain is missing,
equation renders fail at the Manim step (surfaced as a `status="error"` with
LaTeX/`dvisvgm` errors in the render logs) — a host provisioning issue, not a
codegen bug.

The user message is the `by_alias=True` (camelCase) JSON dump of the scene plus
a one-line instruction to respond only via `emit_manim`.

## Coordinate transform usage

The agent reuses the canonical transform from
[`docs/scene-schema.md`](./scene-schema.md): canvas pixels (origin top-left,
**y-DOWN**) → Manim world units (origin center, **y-UP**), driven by the camera
frame so the frame at `zoom=1` fills the Manim frame.

```
Wc, Hc = camera.width, camera.height
s = config.frame_width / Wc            # units per pixel (aspect-locked)
mx =  (px - Wc/2) * s
my = -(py - Hc/2) * s                  # minus sign = the y-axis flip
```

The prompt instructs the model to **hardcode** `Wc`/`Hc` from the payload and
emit a `to_manim` helper, used for stroke points and camera centers alike.

## Keyframe → animation mapping

Object keyframes are `{t, props}` with optional `position` (`[dx, dy]` canvas-px
translation), `scale`, `rotation` (degrees, clockwise in y-down), `opacity`.
Interpolation is **linear**, with hold/clamp before the first and after the last
keyframe. The mapping the prompt encodes:

| Prop | Manim emission | Notes |
| --- | --- | --- |
| `position` delta | `stroke.animate.shift([Δdx*s, -Δdy*s, 0])` | relative displacement → scale only, no origin offset; y flipped |
| `scale` | `stroke.animate.scale(scale_b / scale_a)` | ratio between keyframes |
| `rotation` delta | `stroke.animate.rotate(-(Δrot)*DEGREES)` | negated for the y-flip (cw→ccw) |
| `opacity` | `stroke.animate.set_stroke(opacity=…)` | absolute target |

Each consecutive keyframe pair `(t_a, t_b)` becomes one animation window with
`run_time = t_b - t_a` and `rate_func=linear`. Simultaneous transforms in a
window are chained on a single `.animate` (or grouped) so they run concurrently.

**Window synchronization.** Object and camera keyframes can have different `t`
values, so the prompt prescribes collecting all distinct keyframe times (plus
`0` and `durationSeconds`) into ordered breakpoints, and for each adjacent pair
playing every mobject's interpolated sub-move for that slice together. State at
an arbitrary breakpoint is computed by linearly interpolating the surrounding
keyframes (clamped at the ends). A simpler single-window path is allowed when
the timeline is trivial (e.g. the two-aligned-keyframe fixture).

**Camera.** The initial frame is set statically
(`self.camera.frame.move_to(to_manim(cx0, cy0)).set(width=FW/zoom0)`), then each
camera keyframe pair animates
`self.camera.frame.animate.move_to(to_manim(cx,cy)).set(width=FW/zoom)` over its
window.

## Validation and the repair loop

`generate_manim` statically validates every returned `code` before trusting it
(`validate_code`):

1. non-empty,
2. `ast.parse` succeeds (valid syntax),
3. defines a class whose base name ends in `Scene` (mirrors
   `render.detect_scene_name` so we accept exactly what the renderer runs).

LaTeX-backed mobjects (`MathTex`/`Tex`) are **no longer rejected** — `equation`
objects need `MathTex`, and the render host now provisions LaTeX (see
[LaTeX dependency](#latex-dependency)).

On failure the agent **retries once**, appending the assistant's tool call and a
`tool_result` describing the validation error, asking the model to fix it. If
validation still fails, it returns the best effort with a `[WARNING: …]` prefix
in `notes` rather than raising.

### Future extension: feed render errors back to the model

The current repair loop only reacts to *static* validation failures. The natural
extension (powering the iterate UX in T7/T8) is a **render-aware** repair loop:
pipe the generated code through `render_manim`, and on `status="error"` feed the
captured Manim `logs` back into a follow-up `emit_manim` turn so the model can
fix runtime errors (bad mobject args, missing imports, animation API misuse),
not just syntax. The plumbing — multi-turn `messages`, `tool_result` repair
turns — is already in place; it just needs the render step wired in as an
additional failure source. Few-shot examples of good scene→Manim mappings could
also be added to the prompt to raise first-pass quality.
