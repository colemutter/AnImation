# Preview Flow & Iterate Loop (T7)

The app is a **split screen**: the live editor (canvas + tool palette + timeline
+ camera overlay) on the left, and a **video preview panel** on the right. The
canvas is editable at all times, so the user can fix the drawing and re-convert.

- Shell: [`frontend/src/App.tsx`](../frontend/src/App.tsx) — `.app-shell` is a
  flex row; `.editor-pane` (left) is the positioning context for the floating
  overlays; [`PreviewPanel`](../frontend/src/preview/PreviewPanel.tsx) is the
  right pane.
- Serializer: [`frontend/src/preview/serializeScene.ts`](../frontend/src/preview/serializeScene.ts).
- Styling: [`frontend/src/App.css`](../frontend/src/App.css).

## The Convert flow

Clicking **Convert to Animation** runs a two-call pipeline against the backend:

1. **Serialize** the live store into the [Scene wire shape](./scene-schema.md)
   via `serializeScene(useSceneStore.getState())`.
2. `POST /api/generate` with the Scene JSON → `{ code, notes }`
   (the AI agent turns the scene into Manim source — see
   [`agent-codegen.md`](./agent-codegen.md)).
3. `POST /api/render` with `{ code }` →
   `{ status, videoUrl, logs, sceneName }`
   (the render pipeline executes the Manim — see
   [`render-pipeline.md`](./render-pipeline.md)).
4. On `status: "success"`, the returned `videoUrl` (`/media/...`) plays in a
   `<video>` element in the preview panel.

The flow is fully async and only the preview panel shows a loading state, so the
UI never freezes even though Manim renders can take many seconds. The Convert
button is disabled while a render is in flight; the canvas is never disabled.

### Serialization

`serializeScene` is a **pure** function (state in → `Scene` out, no store access,
no I/O) so it is trivially testable. The store already keeps `objects` in the
exact wire shape, so the serializer just assembles the envelope:

```ts
{
  schemaVersion: SCHEMA_VERSION,           // from types/scene.ts
  timeline: { durationSeconds, fps },      // store: durationSeconds, fps
  camera: { width, height, keyframes },    // store: cameraWidth/Height/Keyframes
  objects,                                 // store: objects (already wire shape)
}
```

Camera keyframes: if the user authored none, the serializer emits a single
keyframe at `t=0` from the live camera base (`cameraCenter`/`cameraZoom`) so the
backend always receives a well-defined camera frame. The output uses camelCase
keys (`schemaVersion`, `durationSeconds`) and validates against
[`backend/schema.py`](../backend/schema.py); it matches the shape of
[`agents/fixtures/example-scene.json`](../agents/fixtures/example-scene.json).

## States

The preview panel renders one of:

- **Empty** — nothing converted yet; a hint to draw and click Convert.
- **Loading** — `Generating Manim code…` then `Rendering video…`, with a spinner.
- **Success** — the `<video>` player (autoplay + loop) plus collapsible agent
  notes. The video `src` is cache-busted with a `?t=<now>` query so a re-convert
  that returns the same `/media/...` path still reloads.
- **Error** — the message plus, on a render failure (`status: "error"`), the
  backend Manim **logs** in an expandable block so the user (and the iterate
  loop) can see what went wrong. A no-objects scene short-circuits to a friendly
  "draw a stroke first" error before any network call.

## The `/media` proxy (critical integration detail)

The Vite dev server only proxies `/api` to the backend. The render response's
`videoUrl` is `/media/...`, which would otherwise hit the Vite dev server, not
the backend. [`frontend/vite.config.ts`](../frontend/vite.config.ts) therefore
proxies **both** `/api` **and** `/media` to `http://localhost:8000`, so the
`<video>` element loads the MP4 from the backend.

## The iterate loop

Because the canvas stays fully editable while a render is in flight and after it
returns, the loop is:

> draw / keyframe / set camera → **Convert** → review the video → fix the canvas
> → **Convert** again → updated video.

Each Convert re-serializes the *current* store state, so edits are always
reflected in the next render. On a render error the surfaced logs are the signal
the user (or a future auto-repair loop) uses to correct the scene.
