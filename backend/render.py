"""Manim render pipeline (T3 spike).

Accepts arbitrary Manim Community Edition source code, executes it in an
**isolated temporary workspace** as a **subprocess** (never ``exec()`` in this
process) with a **timeout**, locates the produced ``.mp4`` and copies it into a
gitignored ``media/`` directory that FastAPI serves statically.

Design notes / threat model
---------------------------
The generated code is *untrusted-ish*: it is run via the Manim CLI in a fresh
temp directory with a wall-clock timeout. This is a spike, so it is NOT a true
sandbox -- the subprocess still runs with the server's privileges. The isolation
boundary here is:

    * a unique temp working directory per request (``tempfile.mkdtemp``),
    * a subprocess (so a crash/segfault cannot take down FastAPI),
    * a hard ``subprocess`` timeout that kills the whole process group, and
    * structured error capture so a bad snippet returns ``status="error"``
      with logs instead of a 500.

For stronger isolation the same shape drops straight onto the
``manimcommunity/manim`` Docker image (swap the ``_build_command`` invocation
for ``docker run --rm -v <workdir>:/manim ...``). That is documented as the
fallback in ``docs/render-pipeline.md``.

The scene class to render is auto-detected from the submitted source via
``ast`` (first class that subclasses something ending in ``Scene``), so callers
do not have to pass a class name. A fixed default (``RENDER_SCENE_DEFAULT``)
is used if detection fails.
"""

from __future__ import annotations

import ast
import shutil
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths / configuration
# ---------------------------------------------------------------------------

BACKEND_DIR = Path(__file__).resolve().parent

# Served, gitignored output directory. The FastAPI app mounts this at /media.
MEDIA_DIR = BACKEND_DIR / "media"
MEDIA_URL_PREFIX = "/media"

# Wall-clock cap for a single render (seconds). Manim cold starts are slow.
RENDER_TIMEOUT_SECONDS = 120

# Render quality flag passed to the Manim CLI. ``-ql`` = 480p15, fastest.
RENDER_QUALITY_FLAG = "-ql"

# Fallback scene class name if we cannot detect one from the source.
RENDER_SCENE_DEFAULT = "GeneratedScene"


@dataclass
class RenderResult:
    """Outcome of a render attempt.

    Attributes
    ----------
    status:
        ``"success"`` if an MP4 was produced, otherwise ``"error"``.
    video_url:
        Public URL (under ``/media``) of the produced MP4, or ``None`` on error.
    logs:
        Combined stdout+stderr from the Manim subprocess (plus pipeline
        diagnostics), useful for surfacing failures to the user/agent.
    scene_name:
        The scene class that was rendered (detected or default).
    """

    status: str
    video_url: str | None = None
    logs: str = ""
    scene_name: str | None = None

    def to_dict(self) -> dict[str, object]:
        """Serialize to the API response shape ``{videoUrl, logs, status}``."""
        return {
            "status": self.status,
            "videoUrl": self.video_url,
            "logs": self.logs,
            "sceneName": self.scene_name,
        }


@dataclass
class _Command:
    argv: list[str] = field(default_factory=list)


def detect_scene_name(code: str) -> str:
    """Return the name of the first ``*Scene`` subclass defined in ``code``.

    Uses ``ast`` so we never execute the source just to inspect it. Falls back
    to :data:`RENDER_SCENE_DEFAULT` when nothing matches (the render will then
    fail loudly via Manim, surfaced as a structured error).
    """
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return RENDER_SCENE_DEFAULT

    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        for base in node.bases:
            # Match ``Scene``, ``MovingCameraScene``, ``ThreeDScene``, etc.,
            # whether referenced bare (Name) or qualified (Attribute).
            base_name = ""
            if isinstance(base, ast.Name):
                base_name = base.id
            elif isinstance(base, ast.Attribute):
                base_name = base.attr
            if base_name.endswith("Scene"):
                return node.name
    return RENDER_SCENE_DEFAULT


def _build_command(scene_file: Path, scene_name: str, media_out: Path) -> list[str]:
    """Build the Manim CLI invocation.

    Runs ``python -m manim render`` using the *current* interpreter so the
    backend's uv-managed virtualenv (with Manim installed) is used. ``--media_dir``
    pins all of Manim's output under our temp workspace so cleanup is trivial.
    """
    return [
        sys.executable,
        "-m",
        "manim",
        "render",
        RENDER_QUALITY_FLAG,
        "--media_dir",
        str(media_out),
        "--disable_caching",
        str(scene_file),
        scene_name,
    ]


def render_manim(code: str, *, timeout: int = RENDER_TIMEOUT_SECONDS) -> RenderResult:
    """Render Manim ``code`` to an MP4 and return a :class:`RenderResult`.

    Steps:
      1. Detect the scene class name from the source (via ``ast``).
      2. Write the source to a ``.py`` file in a fresh temp directory.
      3. Invoke the Manim CLI as a subprocess with a timeout, capturing logs.
      4. Locate the produced ``.mp4`` and copy it into the served ``media/`` dir
         under a unique name.
      5. Clean up the temp workspace.

    Never raises for *render* failures (bad code, timeout, missing Manim): those
    come back as ``status="error"`` with ``logs`` populated.
    """
    scene_name = detect_scene_name(code)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)

    workdir = Path(tempfile.mkdtemp(prefix="manim_render_"))
    log_chunks: list[str] = []
    try:
        scene_file = workdir / "scene.py"
        scene_file.write_text(code, encoding="utf-8")

        # Match the app's WHITE canvas. Manim defaults to a BLACK background, so
        # the canvas's dark strokes (e.g. #1e1e1e) would render invisibly. A
        # manim.cfg in the working dir sets the default deterministically (the
        # generated scene can still override via self.camera.background_color).
        (workdir / "manim.cfg").write_text(
            "[CLI]\nbackground_color = WHITE\n", encoding="utf-8"
        )

        manim_media = workdir / "manim_media"
        cmd = _build_command(scene_file, scene_name, manim_media)
        log_chunks.append(f"$ {' '.join(cmd)}\n")

        try:
            proc = subprocess.run(
                cmd,
                cwd=str(workdir),
                capture_output=True,
                text=True,
                timeout=timeout,
                # Fresh process; do not inherit a partially-configured cwd state.
            )
        except subprocess.TimeoutExpired as exc:
            partial = (exc.stdout or "") + (exc.stderr or "")
            if isinstance(partial, bytes):  # pragma: no cover - defensive
                partial = partial.decode("utf-8", "replace")
            log_chunks.append(partial)
            log_chunks.append(f"\n[render] TIMEOUT after {timeout}s")
            return RenderResult(
                status="error",
                logs="".join(log_chunks),
                scene_name=scene_name,
            )
        except FileNotFoundError as exc:
            # The interpreter or `manim` module is unavailable.
            log_chunks.append(f"[render] could not launch Manim: {exc}")
            return RenderResult(
                status="error",
                logs="".join(log_chunks),
                scene_name=scene_name,
            )

        log_chunks.append(proc.stdout or "")
        log_chunks.append(proc.stderr or "")

        if proc.returncode != 0:
            log_chunks.append(f"\n[render] manim exited with code {proc.returncode}")
            return RenderResult(
                status="error",
                logs="".join(log_chunks),
                scene_name=scene_name,
            )

        mp4 = _find_first_mp4(manim_media)
        if mp4 is None:
            log_chunks.append(
                "\n[render] manim exited 0 but no .mp4 was found under "
                f"{manim_media}"
            )
            return RenderResult(
                status="error",
                logs="".join(log_chunks),
                scene_name=scene_name,
            )

        unique_name = f"{scene_name}_{uuid.uuid4().hex[:8]}.mp4"
        dest = MEDIA_DIR / unique_name
        shutil.copy2(mp4, dest)

        return RenderResult(
            status="success",
            video_url=f"{MEDIA_URL_PREFIX}/{unique_name}",
            logs="".join(log_chunks),
            scene_name=scene_name,
        )
    except Exception as exc:  # pragma: no cover - last-resort guard
        log_chunks.append(f"\n[render] unexpected pipeline error: {exc!r}")
        return RenderResult(
            status="error",
            logs="".join(log_chunks),
            scene_name=scene_name,
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _find_first_mp4(root: Path) -> Path | None:
    """Return the newest ``.mp4`` under ``root`` (Manim nests output deeply)."""
    if not root.exists():
        return None
    candidates = sorted(
        root.rglob("*.mp4"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


# ---------------------------------------------------------------------------
# FastAPI wiring
# ---------------------------------------------------------------------------
#
# Exposes:
#   * POST /api/render   -> run render_manim on the submitted code
#   * a StaticFiles mount at /media that serves produced MP4s
#
# main.py only needs to: `from render import register_render` and call
# `register_render(app)` once. Nothing else in main.py is touched.

from fastapi import APIRouter, FastAPI  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

router = APIRouter()


class RenderRequest(BaseModel):
    """Body for ``POST /api/render``."""

    code: str


class RenderResponse(BaseModel):
    """Response for ``POST /api/render`` (camelCase to match the frontend)."""

    status: str
    videoUrl: str | None = None
    logs: str = ""
    sceneName: str | None = None


@router.post("/api/render", response_model=RenderResponse)
def render_endpoint(req: RenderRequest) -> RenderResponse:
    """Render submitted Manim source to MP4.

    Always returns 200 with a structured body. Render failures (bad code,
    timeout, missing Manim) come back as ``status="error"`` with ``logs`` so the
    client never has to parse a 500.
    """
    result = render_manim(req.code)
    return RenderResponse(**result.to_dict())


def register_render(app: FastAPI) -> None:
    """Attach the render router and mount the served ``media/`` directory.

    Idempotent enough for dev: ensures ``media/`` exists, mounts it at
    :data:`MEDIA_URL_PREFIX`, and includes the render router.
    """
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    app.mount(
        MEDIA_URL_PREFIX,
        StaticFiles(directory=str(MEDIA_DIR)),
        name="media",
    )
    app.include_router(router)
