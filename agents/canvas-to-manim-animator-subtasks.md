# Canvas-to-Manim Animator Subtasks

Generated: 2026-06-25

## Goal
Build an Excalidraw-style drawing app where a user draws on a canvas, moves
drawings through a bottom **timeline slider**, sees a **camera viewport
indicator** showing what the "camera" frames, then clicks **Convert** to send
the scene (objects + camera + timeline keyframes) to an AI agent that generates
**Manim** code. The backend renders that code to a video, which loads in a
side panel so the user can review and edit the canvas to correct it.

## Assumptions
- Builds on the existing scaffold: `frontend/` (Vite + React + TS, `/api`
  proxied to backend) and `backend/` (FastAPI, managed with uv).
- "Looks like excalidraw.com" = hand-drawn/rough aesthetic, floating tool
  palette, infinite pannable/zoomable canvas. Draw (freehand) tool only for now;
  shape/text/select tools are out of scope this pass.
- Manim = [Manim Community Edition](https://www.manim.community/) rendered
  server-side to MP4. LaTeX is optional (avoid `Tex`/`MathTex` in generated code
  unless a LaTeX toolchain is provisioned).
- AI agent = Anthropic SDK with a current Claude model (default
  `claude-opus-4-8`; `claude-sonnet-4-6` acceptable for cost). Consult the
  `/claude-api` skill before writing any Anthropic call.
- Single-user, local-dev target first. No auth, no multi-tenant, no persistence
  beyond the filesystem unless a task says otherwise.
- The animation model is **keyframe-based**: each object and the camera has a
  set of `(t, state)` keyframes; the timeline interpolates between them.

## Execution Shape
- **Critical path:** T2 (schema) -> T6 (AI agent) -> T8 (end-to-end slice),
  with T3 (render pipeline) required before T8 can produce video.
- **Now (de-risk + momentum):** T1 (canvas spike), T2 (schema), T3 (Manim render
  spike). These unblock everything and attack the two riskiest unknowns.
- **Parallel lanes (after Now):** T4 (timeline), T5 (camera) depend on T1+T2;
  T6 (AI agent) depends on T2; T7 (layout/preview) depends on T1.
- **Integration point:** T8 wires canvas serialization -> agent -> render ->
  preview into one vertical slice and validates the loop.
- **Riskiest assumption:** reliable server-side rendering of AI-generated Manim
  (owned by T3 + T6). De-risk both before investing in polish.

## Subtasks

### T1: Spike the canvas foundation and ship a freehand draw tool
- **Outcome:** Frontend renders an infinite, pannable/zoomable canvas with an
  Excalidraw-like floating tool palette and a working freehand draw tool;
  drawn objects live in an app state store. A short ADR records the library
  choice and why.
- **Scope:** In — canvas rendering, pan/zoom, one freehand draw tool, an
  in-memory object model, a state store. Out — timeline, camera indicator,
  shapes/text/eraser, persistence, backend calls.
- **Context packet:** `frontend/` (Vite + React + TS). Candidate approaches to
  compare: `@excalidraw/excalidraw` (closest look, but overlaying a custom
  timeline/camera and reading object state needs care), `tldraw` (highly
  customizable, good React API), or custom `rough.js` + `perfect-freehand` on a
  `<canvas>`/Konva. State store candidate: `zustand`.
- **Reuse/library check:** Use `/deep-dive` to compare `@excalidraw/excalidraw`
  vs `tldraw` vs custom (`rough.js` + `perfect-freehand`/Konva) specifically on:
  (a) can we render a custom bottom timeline and a camera-rectangle overlay,
  (b) can we read/write object geometry programmatically for serialization,
  (c) hand-drawn aesthetic out of the box. Adopt the one that minimizes total
  complexity after integration cost; record the decision.
- **Agent instructions:** Run the reuse check, pick a library, write
  `docs/adr-001-canvas-library.md`, then implement the canvas + draw tool +
  store in `frontend/`. Expose a typed selector that returns the current set of
  drawn objects (this feeds T2/T8). Keep the camera/timeline as clearly marked
  extension points.
- **Expansion path:** If the chosen library blocks overlays or state access,
  document the limitation in the ADR and fall back to the next candidate before
  building further.
- **Acceptance criteria:** `npm run dev` shows the canvas; user can draw
  freehand strokes; pan and zoom work; `useStore.getState().objects` (or
  equivalent) returns the drawn objects; ADR committed.
- **Validation:** Manual draw test + screenshot; `npm run build` passes.
- **Dependencies:** None (start now). Downstream: T4, T5, T7, T8.
- **Handoff:** Working canvas in `frontend/`, the object-selector API, and the ADR.

### T2: Define the scene + animation schema (frontend↔backend↔agent contract)
- **Outcome:** A single versioned schema describing a scene: objects (geometry +
  style), per-object timeline keyframes, camera keyframes, and timeline metadata
  (duration, fps). Published as a Pydantic model on the backend and a matching
  TypeScript type on the frontend, with one example payload.
- **Scope:** In — the data contract and example fixtures. Out — UI, AI calls,
  rendering. This is the spine every other task references.
- **Context packet:** Objects come from T1's draw tool (freehand = ordered
  points + stroke style). Keyframe shape: `{ t: number, props: {...} }` where
  `props` includes position/scale/rotation/opacity. Camera keyframe: `{ t,
  center: [x,y], zoom }`. Timeline: `{ durationSeconds, fps }`. Coordinate
  system convention (canvas px, y-down) must be stated explicitly since Manim
  uses y-up — define the transform now.
- **Agent instructions:** Author `backend/schema.py` (Pydantic v2 models) and
  `frontend/src/types/scene.ts` (kept in sync), plus
  `agents/fixtures/example-scene.json` (a circle moving left→right across two
  keyframes with one camera move). Document the canvas→Manim coordinate
  transform in `docs/scene-schema.md`. Version the schema (`schemaVersion`).
- **Expansion path:** Add object types (rect/line/text) as schema variants later;
  keep the freehand type first. Note where easing/interpolation curves would slot
  in.
- **Acceptance criteria:** Pydantic model validates the example JSON; TS type
  compiles; coordinate transform documented with a worked example; fixture
  committed.
- **Validation:** A tiny script/test loads `example-scene.json` into the Pydantic
  model without error; `tsc` passes on the frontend.
- **Dependencies:** Informed by T1's object shape but can start immediately and
  co-evolve. Downstream: T4, T5, T6, T8 all consume this.
- **Handoff:** `schema.py`, `scene.ts`, `docs/scene-schema.md`, example fixture.

### T3: Spike the Manim render pipeline (known code → MP4 via backend)
- **Outcome:** A backend endpoint that accepts Manim Python source, executes it
  in an isolated workspace, renders to MP4, and returns a playable video URL.
  Proven with a hand-written sample (NOT AI-generated yet). De-risks the
  heaviest dependency early.
- **Scope:** In — Manim install/runtime, safe subprocess execution, output
  capture, error surfacing, serving the MP4. Out — AI generation (T6), UI (T7).
- **Context packet:** `backend/` uses uv. Manim CE needs ffmpeg and cairo/pango;
  decide whether to require them on the host or run rendering in Docker.
  Endpoint sketch: `POST /api/render` `{ code: str }` -> `{ videoUrl, logs,
  status }`. Generated code is untrusted-ish — run it in a temp dir with a
  timeout and resource limits; never `exec()` in-process.
- **Reuse/library check:** Before hand-rolling sandboxing, use `/deep-dive` to
  evaluate running Manim via its CLI in a constrained subprocess vs a Docker
  container (e.g. `manimcommunity/manim` image) vs a sandbox runner. Pick the
  lightest option that gives isolation + a timeout.
- **Agent instructions:** Provision Manim in `backend/`, write `backend/render.py`
  with a `render_manim(code) -> RenderResult` function and wire `POST
  /api/render`. Store outputs under a served `media/` dir (gitignored). Include a
  committed sample scene (`backend/samples/moving_circle.py`) and prove it
  renders. Document system prerequisites in `docs/render-pipeline.md`.
- **Expansion path:** Add render queue/async job + progress if renders are slow;
  add quality/resolution flags; containerize if host installs prove fragile.
- **Acceptance criteria:** `POST /api/render` with the sample returns a URL to a
  playable MP4; a deliberately broken snippet returns a structured error with
  logs (not a 500 crash); timeout enforced.
- **Validation:** curl the endpoint with the sample → open the MP4; curl with
  broken code → see captured error.
- **Dependencies:** None (start now, riskiest). Downstream: T6, T7, T8.
- **Handoff:** Render endpoint, `render.py`, sample scene, prereqs doc.

### T4: Build the timeline slider and keyframe editing (frontend)
- **Outcome:** A bottom timeline bar with a scrubber. Moving the playhead shows
  objects at their interpolated state for time `t`; moving an object at a given
  `t` records a keyframe. Play/pause previews the interpolated animation on the
  canvas.
- **Scope:** In — timeline UI, playhead, per-object keyframe capture,
  interpolation/preview on canvas. Out — camera keyframes (T5), backend calls,
  Manim-accurate easing.
- **Context packet:** Consumes T1's object store and T2's keyframe schema. State
  shape: per object, an array of `{ t, props }`. Default to linear
  interpolation between keyframes. Timeline metadata (duration, fps) from T2.
- **Agent instructions:** Implement a `Timeline` component fixed to the bottom
  (Excalidraw-like chrome), a playhead bound to current `t`, keyframe
  capture-on-move, a linear interpolation function, and a play/pause loop that
  scrubs `t` and re-renders the canvas. Keep keyframe data in the schema shape so
  serialization is trivial.
- **Expansion path:** Add per-keyframe easing curves, a keyframe track/dots UI on
  the timeline, and multi-select. Note these as follow-ups.
- **Acceptance criteria:** Dragging the scrubber moves objects between keyframes;
  setting an object at two different `t` values creates two keyframes;
  play/pause animates the interpolation; state matches T2's schema.
- **Validation:** Manual: animate a stroke across the timeline; screen-recording
  or screenshots at t=0 and t=end; `tsc`/build pass.
- **Dependencies:** T1, T2. Downstream: T8.
- **Handoff:** Timeline component + interpolation utils wired to the store.

### T5: Add the camera viewport indicator and camera keyframes (frontend)
- **Outcome:** A draggable/resizable rectangle overlay representing the camera
  frame (aspect-locked to the output video). Its position/zoom can be keyframed
  on the timeline so the "camera" moves over time, mirroring Manim's camera.
- **Scope:** In — camera rectangle overlay, drag/resize, camera keyframes tied to
  the timeline, aspect-ratio lock. Out — actually cropping/rendering the camera
  (that happens in Manim via T6), object keyframes (T4).
- **Context packet:** Consumes T1 (canvas/overlay) and T2 (camera keyframe shape
  `{ t, center, zoom }`) and T4 (timeline `t`). Camera frame aspect must match
  the render resolution from T3 (e.g. 16:9). Reuse the coordinate transform from
  T2 so camera state maps cleanly to Manim's `frame`.
- **Agent instructions:** Render an overlay rectangle on the canvas, make it
  drag/resize with aspect lock, and capture camera keyframes as the timeline
  moves (same capture pattern as T4). Show the camera interpolating during
  play/pause.
- **Expansion path:** Add a "camera view" preview thumbnail, multiple cameras, or
  camera easing later.
- **Acceptance criteria:** Camera rectangle is visible and movable; setting it at
  two timeline points creates two camera keyframes; it animates on play; values
  serialize into T2's schema.
- **Validation:** Manual: keyframe a camera pan; confirm serialized camera
  keyframes; build passes.
- **Dependencies:** T1, T2, T4 (shares timeline). Downstream: T6, T8.
- **Handoff:** Camera overlay component + camera keyframe state.

### T6: Implement the AI agent: scene JSON → Manim code (backend)
- **Outcome:** `POST /api/generate` takes a T2 scene payload and returns valid,
  runnable Manim code (plus the model's reasoning/notes), using the Anthropic
  SDK and a well-engineered prompt that encodes the coordinate transform,
  keyframe → animation mapping, and "no LaTeX" constraint.
- **Scope:** In — prompt design, Anthropic call, response parsing, light static
  validation of returned code. Out — executing the code (that's T3's endpoint),
  UI.
- **Context packet:** Consumes T2's schema/fixture. **Before writing any
  Anthropic call, consult the `/claude-api` skill** for current model IDs, tool
  use, and SDK usage. Default model `claude-opus-4-8`. The prompt must: map each
  object's keyframes to Manim `.animate`/`Transform` calls over the right time
  windows, apply the canvas→Manim coordinate transform from T2, drive
  `self.camera.frame` from camera keyframes (use `MovingCameraScene`), and avoid
  `Tex`/`MathTex` unless LaTeX is provisioned. Return code as a single `Scene`
  subclass with a known class name so T3 can render it.
- **Reuse/library check:** Prefer the official `anthropic` Python SDK; do not
  hand-roll HTTP. Consider structured output / tool use to force a clean
  `{ code, notes }` response.
- **Agent instructions:** Implement `backend/agent.py` with `generate_manim(scene)
  -> { code, notes }` and wire `POST /api/generate`. Add a prompt file/template.
  Validate the returned code parses (`ast.parse`) and defines the expected Scene
  class before returning. Use `agents/fixtures/example-scene.json` as the test
  input.
- **Expansion path:** Add a repair loop — if T3 render fails, feed logs back to
  the model for a fix (this powers the iterate UX in T7/T8). Add few-shot
  examples of good scene→Manim mappings.
- **Acceptance criteria:** Posting the example scene returns code that
  `ast.parse`s and defines the expected class; running that code through T3's
  `/api/render` produces a video matching the intended motion (circle moves
  L→R with the camera move).
- **Validation:** Integration check: `generate` → `render` on the fixture yields
  a playable MP4; bad/empty scenes return a clear error.
- **Dependencies:** T2 (schema), and T3 to fully validate output. Downstream: T8.
- **Handoff:** `agent.py`, prompt template, `/api/generate` endpoint.

### T7: Build the split-screen layout, video preview, and iterate loop (frontend)
- **Outcome:** App shell with canvas on one side and a video preview panel on the
  other, a "Convert to Animation" button, loading/error states, and the loop:
  edit canvas → re-convert → new video. The user can correct the canvas when the
  output is wrong.
- **Scope:** In — responsive split layout, Convert button that serializes the
  scene (T2) and calls `/api/generate` then `/api/render`, a video player,
  loading/error/empty states, re-run. Out — the rendering/generation internals
  (T3/T6), auth, history.
- **Context packet:** Serialize the store (T1/T4/T5) into a T2 payload. Call
  `POST /api/generate` → `POST /api/render` (or a combined endpoint if the team
  prefers). Show the returned MP4 in a `<video>`. Surface backend logs on error
  so the user/agent can react.
- **Agent instructions:** Build the split-screen shell, the Convert action
  (serialize → generate → render → play), and clear status UI. Keep the canvas
  fully editable while a render is in flight or after it returns, so the iterate
  loop works.
- **Expansion path:** Add a render history/versions strip, a diff between
  attempts, and an "auto-repair" button that pipes render errors back to T6's
  repair loop.
- **Acceptance criteria:** Clicking Convert serializes the current scene, shows a
  loading state, then plays the returned video beside the canvas; editing the
  canvas and re-clicking produces an updated video; errors are visible.
- **Validation:** Manual end-to-end click-through with screenshots of both
  panes; build passes.
- **Dependencies:** T1 (canvas), T6 + T3 (endpoints). Downstream: T8.
- **Handoff:** App shell + preview panel + Convert flow.

### T8: Integrate the end-to-end vertical slice and validate the loop
- **Outcome:** One proven path: draw a stroke → keyframe its motion → set a
  camera move → click Convert → AI generates Manim → backend renders → video
  plays in the side panel → edit canvas → re-render reflects the change.
- **Scope:** In — wiring all pieces, fixing contract mismatches, a documented
  smoke test of the whole loop. Out — new features beyond the slice.
- **Context packet:** Consumes every prior task. The acceptance scenario mirrors
  `agents/fixtures/example-scene.json` but driven entirely through the UI.
- **Agent instructions:** Run the full flow, fix integration gaps (schema drift,
  coordinate bugs, CORS/proxy, media serving), and write
  `docs/end-to-end-demo.md` with the exact steps and expected result. Confirm the
  iterate loop changes the output.
- **Expansion path:** Once green, turn the riskiest manual steps into automated
  tests; enable the T6 auto-repair loop.
- **Acceptance criteria:** A fresh `npm run dev` + backend run lets a user
  complete the whole loop and get a correct-looking animation; a canvas edit
  visibly changes the re-rendered video; demo doc committed.
- **Validation:** Recorded/scripted walkthrough or screenshot sequence of the
  full loop; both `build` and backend import/render checks pass.
- **Dependencies:** T1–T7. This is the integration gate.
- **Handoff:** Working slice + `docs/end-to-end-demo.md`.

## Coordination Notes
- **Schema is the spine:** any change to T2 ripples to T4, T5, T6, T8. Freeze a
  `schemaVersion` early and bump it deliberately.
- **Two early de-risks run in parallel:** T1 (will the canvas support our
  overlays?) and T3 (can we render Manim at all?). Do not build T4–T7 heavily
  until both return green.
- **Coordinate transform is a classic bug source:** canvas is y-down, Manim is
  y-up. Define it once in T2 and reuse it in T5 (camera) and T6 (codegen).
- **File-ownership / parallelism:** T4 and T5 both touch the timeline/store —
  have T4 land the timeline + interpolation first, then T5 reuses its keyframe
  pattern to avoid merge conflicts. T6 (backend) and T7 (frontend) are
  independent and parallelizable once T2/T3 exist.
- **AI calls:** every task that calls Anthropic must consult `/claude-api` first
  for current model IDs and SDK patterns — do not answer from memory.
- **Decision gate:** if T3 shows host-level Manim installs are fragile,
  containerize before continuing (don't paper over flaky renders in later tasks).

## Suggested Next Dispatch
Start T2 and T3 immediately, with T1 alongside:

> **T3 (riskiest, do first):** In the `backend/` (FastAPI + uv) project, provision
> Manim Community Edition and build a `POST /api/render` endpoint that accepts
> `{ code: str }`, executes it in an isolated temp workspace with a timeout
> (never in-process), renders to MP4, and returns `{ videoUrl, logs, status }`,
> serving the file from a gitignored `media/` dir. Commit a hand-written sample
> `backend/samples/moving_circle.py` and prove it renders end-to-end; make a
> broken snippet return a structured error instead of a 500. Before hand-rolling
> isolation, use `/deep-dive` to compare a constrained subprocess vs the
> `manimcommunity/manim` Docker image and pick the lightest option that gives
> isolation + timeout. Document host prerequisites in `docs/render-pipeline.md`.
