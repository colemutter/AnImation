# End-to-end demo: draw → animate → Convert → render → review

This walks the full loop the app implements, and records exactly what has been
verified.

## Prerequisites

- Node 20+ and npm
- [uv](https://docs.astral.sh/uv/) with the backend deps installed (Manim CE,
  FastAPI, anthropic) — `cd backend && uv sync`
- **An `ANTHROPIC_API_KEY`** in the backend's environment (required for the
  `/api/generate` codegen step).
- ffmpeg on PATH (used by Manim). LaTeX is *not* required — generated scenes
  avoid `Tex`/`MathTex`.

## Run

Two terminals:

```bash
# 1) backend (FastAPI: /api/generate, /api/render, /media)
cd backend
ANTHROPIC_API_KEY=sk-ant-... uv run uvicorn main:app --port 8000

# 2) frontend (Vite dev server; proxies /api and /media to :8000)
cd frontend
npm run dev          # http://localhost:5173
```

## The loop

1. **Draw** a stroke on the canvas (✎ tool).
2. **Animate** it: with the Select tool (✋/V), move the playhead on the bottom
   timeline to a time and drag the stroke — that captures a position keyframe.
   Repeat at another time to create motion. Keyframes show as diamonds.
3. **Camera**: drag/resize the purple camera frame at different times to capture
   camera keyframes (a pan/zoom). Aspect is locked to 1920×1080 (16:9).
4. **Convert**: click **Convert to Animation**. The frontend serializes the
   scene (`frontend/src/preview/serializeScene.ts`) into the wire schema and
   calls `POST /api/generate` → gets Manim `code` → `POST /api/render` → gets a
   `/media/*.mp4` URL.
5. **Review**: the rendered video plays in the right pane. If it's wrong, edit
   the canvas and click Convert again (the canvas stays editable throughout).
   On any failure the pane shows the backend error/logs so you can correct it.

## Verification status (2026-06-25)

Verified end-to-end **without** an API key:

- ✅ Canvas + freehand draw (smooth `perfect-freehand` strokes).
- ✅ Timeline: scrubbing interpolates a stroke between two position keyframes
  (confirmed in-browser at t=0 vs t=5).
- ✅ Camera frame: pans + zooms across camera keyframes on scrub (confirmed
  in-browser).
- ✅ Convert wiring: serialized payload passes backend schema validation (the
  failure occurs *inside* the handler at the Anthropic call, i.e. a 500 not a
  422) and the error UI renders cleanly.
- ✅ Render pipeline: `POST /api/render` on a hand-written scene returns a
  playable MP4; a broken snippet returns a structured error (no 500).
- ✅ `/media` proxy: the rendered MP4 is fetchable through the Vite dev server
  at `http://localhost:5173/media/...`, so a successful generate will display
  in the preview pane.

Pending (needs a key):

- ⏳ The live `/api/generate` hop — i.e. the AI actually producing renderable
  Manim from a real scene. Set `ANTHROPIC_API_KEY` and run the loop above (or
  the scripted check below) to confirm generate→render produces a correct MP4.

### Scripted live check (with a key)

```bash
cd backend
uv run --env-file .env python - <<'PY'
import json, agent, render
from schema import Scene
# generate_manim expects a Scene model (over HTTP, FastAPI parses it for you).
scene = Scene.model_validate(json.load(open("../agents/fixtures/example-scene.json")))
g = agent.generate_manim(scene)            # AI -> {code, notes}
print("notes:", g["notes"][:200])
r = render.render_manim(g["code"])         # Manim -> MP4
print("render:", r.status, r.video_url)
print(r.logs[-500:] if r.status != "success" else "OK")
PY
```

> Verified live (2026-06-25): generate returned valid Manim (41 lines, `Scene`
> subclass, no LaTeX), render produced a playable MP4, and the video plays in the
> preview pane — confirmed both via HTTP and through the in-app Convert button.

## Known follow-ups

- `/api/generate` raises (HTTP 500) on backend failure; `/api/render` returns a
  structured `{status:"error", logs}` 200. Consider making `/api/generate`
  symmetric (catch → structured error) so the preview pane can show the real
  message instead of "Internal Server Error".
- Auto-repair loop: feed `/api/render` error logs back into `generate_manim` for
  a fix pass (documented in `docs/agent-codegen.md`).
- Show camera keyframes on the timeline track (deferred in T5 to keep T4's
  `Timeline.tsx` untouched).
