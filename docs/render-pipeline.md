# Render Pipeline (T3)

Status: **complete** — Manim Community Edition renders end-to-end on this host
(macOS / Apple Silicon / Python 3.14).

The backend exposes `POST /api/render`, which takes hand-written or AI-generated
Manim source, runs it in an isolated temp workspace as a subprocess with a
timeout, and serves the resulting MP4 from a gitignored `media/` directory.

## API

`POST /api/render`

Request:

```json
{ "code": "<python source defining a Manim Scene subclass>" }
```

Response (always HTTP 200, even on render failure):

```json
{
  "status": "success",            // or "error"
  "videoUrl": "/media/MovingCircle_b99f37ff.mp4",  // null on error
  "logs": "<combined stdout+stderr from manim>",
  "sceneName": "MovingCircle"     // auto-detected from the source
}
```

The produced MP4 is served statically at `/media/<name>.mp4` (FastAPI
`StaticFiles` mount). During local dev that is
`http://127.0.0.1:8131/media/...`.

## Host prerequisites

Verified working configuration on this machine:

| Component        | Version / status        | Notes |
|------------------|-------------------------|-------|
| OS / arch        | macOS (darwin), arm64   | Apple Silicon |
| Python           | 3.14.3 (uv-managed)     | backend `.venv` |
| Manim CE         | 0.20.1                  | `uv add manim` |
| cairo / pango    | present (dev headers)   | `pycairo` and `manimpango` built from source during install — proves the C headers are available on the host |
| ffmpeg           | present on PATH         | Manim invoked it to combine partial movie files into the final MP4; no manual install was needed on this host |
| LaTeX            | not required            | the sample and the agent prompt avoid `Tex`/`MathTex` |

### If provisioning on a fresh host

1. Backend Python deps (already done here):
   ```sh
   cd backend && uv add manim
   ```
   On this host all native wheels/builds succeeded because the cairo and pango
   development headers were already present (Homebrew). If `pycairo` /
   `manimpango` fail to build on another machine, install the C libraries first:
   ```sh
   brew install cairo pango pkg-config
   ```
2. ffmpeg is a **runtime** dependency of Manim (used to mux video). It was
   already on PATH here. If `manim` reports it cannot find ffmpeg:
   ```sh
   brew install ffmpeg
   ```
3. (Optional) For `Tex`/`MathTex` you would also need a LaTeX distribution
   (e.g. MacTeX / `brew install --cask mactex-no-gui`). We deliberately avoid
   LaTeX, so this is not installed.

## How isolation is achieved

Implemented in `backend/render.py` (`render_manim`):

1. **Never `exec()` in-process.** The submitted code is written to a `.py` file
   and run by invoking the Manim CLI as a **subprocess**
   (`python -m manim render ...` using the backend venv's interpreter).
2. **Isolated workspace.** Each request gets a fresh
   `tempfile.mkdtemp(prefix="manim_render_")` directory. The source file and
   *all* of Manim's output (`--media_dir <workdir>/manim_media`) live there, so
   one request can't see or clobber another's files. The temp dir is removed in
   a `finally` block.
3. **Timeout.** `subprocess.run(..., timeout=120)`. On `TimeoutExpired` the
   partial output is captured and the call returns `status="error"` — the
   server never hangs.
4. **Structured errors, no 500s.** Non-zero exit, timeout, missing Manim, or a
   missing output file all return `status="error"` with `logs` populated. The
   FastAPI route always responds 200 with the structured body.
5. **Unique served names.** The newest `.mp4` under the temp media dir is copied
   into `backend/media/` as `<SceneName>_<8hexchars>.mp4` and exposed at
   `/media/...`.

Scene-class detection uses `ast.parse` (no execution) to find the first class
whose base name ends in `Scene` (`Scene`, `MovingCameraScene`, `ThreeDScene`,
…), so callers don't have to pass a class name.

### Reuse decision: subprocess vs Docker

For this spike a **constrained subprocess** was chosen over the
`manimcommunity/manim` Docker image because Manim installs and renders cleanly
on the host, and a subprocess gives the two properties we needed (a temp-dir
workspace + a hard timeout) with zero extra infra and far lower latency (no
container cold start, no volume mounting).

**Docker is the documented fallback** if host installs prove fragile in CI or on
other machines, or if stronger isolation is required (the subprocess still runs
with the server's privileges — this is a spike, not a hardened sandbox). The
code is structured for an easy swap: replace the argv built in
`_build_command(...)` with, e.g.:

```
docker run --rm -v <workdir>:/manim -w /manim manimcommunity/manim \
    manim render -ql --media_dir /manim/manim_media \
    --disable_caching scene.py <SceneName>
```

Everything else (temp dir, timeout, mp4 discovery, copy-to-`media/`, serving)
stays the same.

## Files

- `backend/render.py` — `render_manim(code) -> RenderResult`, `RenderResult`,
  the `POST /api/render` router, and `register_render(app)` (mounts `/media`).
- `backend/main.py` — calls `register_render(app)` (one added import + one call;
  existing routes and CORS untouched).
- `backend/samples/moving_circle.py` — hand-written sample: a blue circle slides
  left→right while a `MovingCameraScene` camera pans/zooms with it. No LaTeX.
- `backend/pyproject.toml` / `uv.lock` — `manim>=0.20.1` added via `uv add`.
- `media/` — gitignored output dir (entry added to root `.gitignore`).

## Validation performed

Server started with `uv run uvicorn main:app --port 8131`, then:

- **Sample render (success):** `POST /api/render` with `moving_circle.py` →
  `status:"success"`, `videoUrl:"/media/MovingCircle_*.mp4"`. Fetching that URL
  returned a valid 21,660-byte MP4 (ISO `ftyp` box present, playable).
- **Broken code (structured error):** `POST /api/render` with code referencing an
  undefined name → HTTP **200** with `status:"error"`, `videoUrl:null`, and the
  `NameError` captured in `logs`. No 500 crash.
- Direct `render_manim()` unit-style checks confirmed temp-dir isolation,
  scene auto-detection, and copy-to-`media/` independently of HTTP.

## Known issues / follow-ups

- `pydub` emits harmless `SyntaxWarning`s (invalid escape sequences) on Python
  3.14 at import time. Cosmetic; does not affect rendering.
- The subprocess runs with the server's privileges — fine for single-user local
  dev, but **not** a security boundary. Containerize (Docker fallback above) or
  add OS-level resource limits before exposing this beyond localhost.
- Default quality is `-ql` (480p15) for fast spikes. Expose a quality/resolution
  flag (e.g. `-qm`/`-qh`) when render quality matters (T7/T8).
- No render queue: requests are synchronous and block for the render duration
  (a few seconds at `-ql`). Add an async job + progress if renders get slow.
- `media/` is never garbage-collected; old MP4s accumulate. Add cleanup if this
  becomes a long-running service.
