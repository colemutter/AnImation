"""AI agent (T6): turn a Scene payload into runnable Manim code.

This module owns the Anthropic call that converts a :class:`schema.Scene`
(the frontend<->backend<->agent contract) into a single ``MovingCameraScene``
subclass that :mod:`render` can execute.

Design
------
* The official ``anthropic`` Python SDK is used (never hand-rolled HTTP).
* We force **structured output via tool use**: the model must respond by
  calling a single ``emit_manim`` tool whose ``input`` is ``{code, notes}``.
  ``tool_choice`` pins that tool so we always get a clean object back instead
  of having to scrape a code fence out of free text.
* The bulk of the domain knowledge -- the canvas->Manim coordinate transform,
  the keyframe->animation mapping, the "no LaTeX" constraint, and the
  ``MovingCameraScene`` contract -- lives in the system prompt
  (``backend/prompts/manim_system.txt``).
* Returned code is **statically validated** before we trust it: it must
  ``ast.parse`` and define a class whose base name ends in ``Scene``. On
  failure we retry once (feeding the parse/validation error back to the model),
  then return the best effort with an explanatory note.

The model id defaults to ``claude-opus-4-8`` (per the ``/claude-api`` skill);
``claude-sonnet-4-6`` is kept as a cheaper fallback constant. ``system`` is a
top-level kwarg, ``max_tokens`` is required, and a forced ``tool_use`` block's
``.input`` is already a parsed dict.

The endpoint never executes the code -- that is the render pipeline's job
(``backend/render.py``). This module only generates + statically validates.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

from schema import Scene

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BACKEND_DIR = Path(__file__).resolve().parent
PROMPT_PATH = BACKEND_DIR / "prompts" / "manim_system.txt"

# Model ids confirmed current via the /claude-api skill (June 2026).
MODEL_DEFAULT = "claude-opus-4-8"
MODEL_FALLBACK = "claude-sonnet-4-6"  # cheaper Sonnet fallback

# Generous cap: a full windowed scene module can be a few hundred lines.
MAX_TOKENS = 8000

# How many times to re-ask the model after a validation failure.
MAX_REPAIRS = 1

# The structured-output tool the model is forced to call.
EMIT_TOOL = {
    "name": "emit_manim",
    "description": (
        "Emit the generated Manim source for the scene. Call this exactly "
        "once. `code` is a complete, runnable Manim module defining a single "
        "MovingCameraScene subclass; `notes` is a terse explanation of the "
        "keyframe->animation and coordinate mapping."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": (
                    "Complete Manim Python module: imports, one "
                    "MovingCameraScene subclass, full construct(). No markdown "
                    "fences, no LaTeX (no Tex/MathTex)."
                ),
            },
            "notes": {
                "type": "string",
                "description": "1-4 sentences on how the scene was mapped.",
            },
        },
        "required": ["code", "notes"],
    },
}


# ---------------------------------------------------------------------------
# Static validation of returned code
# ---------------------------------------------------------------------------


def _defines_scene_class(code: str) -> bool:
    """True if ``code`` parses and defines a class whose base ends in ``Scene``.

    Mirrors the detection logic in :func:`render.detect_scene_name` so what we
    accept here is exactly what the renderer can run.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        for base in node.bases:
            base_name = ""
            if isinstance(base, ast.Name):
                base_name = base.id
            elif isinstance(base, ast.Attribute):
                base_name = base.attr
            if base_name.endswith("Scene"):
                return True
    return False


def validate_code(code: str) -> tuple[bool, str]:
    """Validate generated code. Returns ``(ok, reason)``.

    ``reason`` is empty on success and otherwise a short, model-readable
    description of what was wrong (fed back into the repair attempt).
    """
    if not code or not code.strip():
        return False, "empty code"
    try:
        ast.parse(code)
    except SyntaxError as exc:
        return False, f"SyntaxError: {exc.msg} (line {exc.lineno})"
    if not _defines_scene_class(code):
        return (
            False,
            "no class subclassing a *Scene type was found; define one class "
            "subclassing MovingCameraScene.",
        )
    # Cheap LaTeX guard: the render host has no LaTeX toolchain.
    for banned in ("MathTex(", "Tex(", "Title("):
        if banned in code:
            return False, f"uses LaTeX-backed mobject {banned!r}; use Text(...) instead."
    return True, ""


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------


def _load_system_prompt() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


def _scene_to_user_message(scene: Scene) -> str:
    """Render the scene payload (camelCase JSON) as the user turn."""
    payload = scene.model_dump(by_alias=True)
    pretty = json.dumps(payload, indent=2)
    return (
        "Convert the following scene JSON into a single MovingCameraScene "
        "Manim class, applying the coordinate transform and keyframe->animation "
        "mapping from the system instructions. Respond ONLY by calling the "
        "emit_manim tool.\n\nSCENE JSON:\n" + pretty
    )


def _extract_tool_result(response: Any) -> dict[str, str]:
    """Pull ``{code, notes}`` out of the forced ``tool_use`` block.

    A forced tool call yields a content block of ``type == "tool_use"`` whose
    ``.input`` is already a parsed dict. We fall back to any text block if no
    tool block is present (defensive; shouldn't happen with tool_choice).
    """
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "emit_manim":
            data = block.input or {}
            return {
                "code": str(data.get("code", "")),
                "notes": str(data.get("notes", "")),
            }
    # Defensive fallback: stitch any text blocks together as "code".
    text = "".join(
        getattr(b, "text", "") for b in response.content if getattr(b, "type", None) == "text"
    )
    return {"code": text, "notes": ""}


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def generate_manim(scene: Scene, *, model: str = MODEL_DEFAULT) -> dict[str, str]:
    """Generate Manim code for ``scene``.

    Parameters
    ----------
    scene:
        A validated :class:`schema.Scene` payload.
    model:
        Anthropic model id. Defaults to :data:`MODEL_DEFAULT`
        (``claude-opus-4-8``); pass :data:`MODEL_FALLBACK` for a cheaper run.

    Returns
    -------
    dict
        ``{"code": <manim source>, "notes": <short reasoning>}``. The code is
        statically validated (parses + defines a ``*Scene`` class) when
        possible; if validation never passes after the repair attempt, the
        best effort is returned with a ``notes`` prefix flagging the failure.

    Notes
    -----
    Imports the ``anthropic`` SDK lazily so this module can be imported (and
    its validation helpers exercised) without the dependency or an API key
    present. Raises ``RuntimeError`` only if the SDK is missing when an actual
    API call is attempted.
    """
    try:
        import anthropic  # lazy: keeps structural import/validation key-free
    except ImportError as exc:  # pragma: no cover - exercised only without dep
        raise RuntimeError(
            "the `anthropic` package is required to generate code; run "
            "`uv add anthropic` in backend/."
        ) from exc

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the env
    system_prompt = _load_system_prompt()

    messages: list[dict[str, Any]] = [
        {"role": "user", "content": _scene_to_user_message(scene)}
    ]

    last: dict[str, str] = {"code": "", "notes": ""}

    for attempt in range(MAX_REPAIRS + 1):
        response = client.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system_prompt,
            tools=[EMIT_TOOL],
            tool_choice={"type": "tool", "name": "emit_manim"},
            messages=messages,
        )
        last = _extract_tool_result(response)
        ok, reason = validate_code(last["code"])
        if ok:
            return last

        if attempt >= MAX_REPAIRS:
            break

        # Feed the assistant's tool call + a repair request back for one retry.
        messages.append({"role": "assistant", "content": response.content})
        # The forced tool call requires a tool_result for the tool_use id.
        tool_use_id = _first_tool_use_id(response)
        messages.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": (
                            "The code you emitted failed validation: "
                            f"{reason}. Fix it and call emit_manim again with a "
                            "single MovingCameraScene subclass, valid Python "
                            "syntax, and no LaTeX-backed mobjects."
                        ),
                    }
                ],
            }
        )

    # Validation never passed; return best effort with a flag in the notes.
    _ok, reason = validate_code(last["code"])
    last["notes"] = (
        f"[WARNING: generated code failed validation: {reason}] " + (last.get("notes") or "")
    ).strip()
    return last


def _first_tool_use_id(response: Any) -> str:
    """Return the id of the first ``tool_use`` block (for the repair turn)."""
    for block in response.content:
        if getattr(block, "type", None) == "tool_use":
            return block.id
    return "unknown"


# ---------------------------------------------------------------------------
# FastAPI wiring
# ---------------------------------------------------------------------------
#
# Exposes POST /api/generate. main.py only needs:
#     from agent import register_agent
#     register_agent(app)
# Mirrors render.register_render so existing routes/CORS are untouched.

from fastapi import APIRouter, FastAPI, HTTPException  # noqa: E402
from pydantic import BaseModel  # noqa: E402

router = APIRouter()


class GenerateResponse(BaseModel):
    """Response for ``POST /api/generate`` (matches the agent contract)."""

    code: str
    notes: str


@router.post("/api/generate", response_model=GenerateResponse)
def generate_endpoint(scene: Scene) -> GenerateResponse:
    """Generate Manim source for a posted :class:`schema.Scene`.

    The request body is the scene payload itself (same shape as
    ``agents/fixtures/example-scene.json``). Returns ``{code, notes}``.
    Configuration/SDK problems (missing key/package) surface as a 500 with a
    readable detail rather than an opaque crash.
    """
    try:
        result = generate_manim(scene)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return GenerateResponse(code=result["code"], notes=result["notes"])


def register_agent(app: FastAPI) -> None:
    """Attach the generate router. Mirrors :func:`render.register_render`."""
    app.include_router(router)
