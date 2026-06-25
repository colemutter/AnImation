"""Scene + animation schema — the frontend↔backend↔agent contract.

This module defines the single, versioned data model that describes an
animated scene: drawable objects (geometry + style), per-object timeline
keyframes, camera keyframes, and timeline metadata (duration, fps).

The animation model is keyframe-based: each object and the camera carries a
set of ``(t, props)`` keyframes that the timeline interpolates between.

This Pydantic v2 model is kept structurally in sync with the TypeScript types
in ``frontend/src/types/scene.ts``. Field names and shapes must match exactly.

Coordinate convention: object geometry and camera positions are expressed in
**canvas pixels with a y-DOWN axis** (the native browser canvas system). The
canvas→Manim (y-UP, world units) transform is defined once in
``docs/scene-schema.md`` and applied by the codegen agent (T6), NOT here.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

# Bump deliberately when the shape changes; consumers should reject unknown
# major versions. See "Coordination Notes" in the subtasks doc.
SCHEMA_VERSION = "1.1.0"


class _Model(BaseModel):
    """Base config shared by every schema model.

    ``extra="forbid"`` makes the contract strict: an unexpected field is a
    validation error rather than silently dropped, which surfaces schema drift
    between the frontend, backend, and agent early.
    """

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Geometry primitives
# ---------------------------------------------------------------------------


class Point(_Model):
    """A single 2D point in canvas pixel space (y-DOWN)."""

    x: float
    y: float


class StrokeStyle(_Model):
    """Visual style for a freehand stroke."""

    # CSS-style color string, e.g. "#1e1e1e" or "rgb(30,30,30)".
    color: str = "#1e1e1e"
    # Stroke width in canvas pixels.
    width: float = Field(default=2.0, gt=0)
    # 0 (transparent) .. 1 (opaque). Base opacity before per-keyframe opacity.
    opacity: float = Field(default=1.0, ge=0, le=1)


# ---------------------------------------------------------------------------
# Object variants. Each variant carries a unique ``type`` literal discriminant,
# shared ``id``/``keyframes``, and its own geometry/style fields. They are
# unioned below via a Pydantic discriminated union on ``type``.
# ---------------------------------------------------------------------------


class FreehandObject(_Model):
    """A freehand stroke: an ordered list of points plus stroke style.

    The original v1 object type. Maps to a Manim path/``VMobject`` of the
    points.
    """

    id: str
    type: Literal["freehand"] = "freehand"
    # Ordered stroke points in canvas pixel space (y-DOWN).
    points: list[Point] = Field(min_length=1)
    style: StrokeStyle = Field(default_factory=StrokeStyle)
    # Per-object animation keyframes, expected sorted by ``t`` ascending.
    keyframes: list[ObjectKeyframe] = Field(default_factory=list)


class TextObject(_Model):
    """A text box; ``position`` is the top-left anchor. Maps to Manim ``Text``."""

    id: str
    type: Literal["text"] = "text"
    # Top-left anchor in canvas pixel space (y-DOWN).
    position: list[float] = Field(min_length=2, max_length=2)
    text: str
    # Font size in canvas pixels.
    font_size: float = Field(alias="fontSize", gt=0)
    color: str = "#1e1e1e"
    keyframes: list[ObjectKeyframe] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class EquationObject(_Model):
    """A LaTeX equation box; top-left anchored. Maps to Manim ``MathTex``."""

    id: str
    type: Literal["equation"] = "equation"
    # Top-left anchor in canvas pixel space (y-DOWN).
    position: list[float] = Field(min_length=2, max_length=2)
    # LaTeX source (math mode), e.g. "E = mc^2".
    latex: str
    font_size: float = Field(alias="fontSize", gt=0)
    color: str = "#1e1e1e"
    keyframes: list[ObjectKeyframe] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class LineObject(_Model):
    """A straight line segment from ``start`` to ``end``. Maps to Manim ``Line``."""

    id: str
    type: Literal["line"] = "line"
    # Endpoints in canvas pixel space (y-DOWN).
    start: list[float] = Field(min_length=2, max_length=2)
    end: list[float] = Field(min_length=2, max_length=2)
    style: StrokeStyle = Field(default_factory=StrokeStyle)
    keyframes: list[ObjectKeyframe] = Field(default_factory=list)


class ArrowObject(_Model):
    """A straight arrow from ``start`` (tail) to ``end`` (head). Maps to Manim ``Arrow``."""

    id: str
    type: Literal["arrow"] = "arrow"
    # Tail/head in canvas pixel space (y-DOWN).
    start: list[float] = Field(min_length=2, max_length=2)
    end: list[float] = Field(min_length=2, max_length=2)
    style: StrokeStyle = Field(default_factory=StrokeStyle)
    keyframes: list[ObjectKeyframe] = Field(default_factory=list)


class RectObject(_Model):
    """An axis-aligned rectangle, top-left anchored. Maps to Manim ``Rectangle``."""

    id: str
    type: Literal["rect"] = "rect"
    # Top-left corner in canvas pixel space (y-DOWN).
    position: list[float] = Field(min_length=2, max_length=2)
    # Extends right/down from ``position``, in canvas pixels.
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    style: StrokeStyle = Field(default_factory=StrokeStyle)
    # Fill color (CSS string), or None for no fill.
    fill: str | None = None
    keyframes: list[ObjectKeyframe] = Field(default_factory=list)


class EllipseObject(_Model):
    """An axis-aligned ellipse centered at ``center``. Maps to Manim ``Ellipse``."""

    id: str
    type: Literal["ellipse"] = "ellipse"
    # Center in canvas pixel space (y-DOWN).
    center: list[float] = Field(min_length=2, max_length=2)
    # Horizontal/vertical radii in canvas pixels.
    radius_x: float = Field(alias="radiusX", gt=0)
    radius_y: float = Field(alias="radiusY", gt=0)
    style: StrokeStyle = Field(default_factory=StrokeStyle)
    fill: str | None = None
    keyframes: list[ObjectKeyframe] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class TriangleObject(_Model):
    """A triangle given by its three vertices. Maps to Manim ``Polygon``/``Triangle``."""

    id: str
    type: Literal["triangle"] = "triangle"
    # Exactly three vertices as [x, y] pairs in canvas pixel space (y-DOWN).
    points: list[list[float]] = Field(min_length=3, max_length=3)
    style: StrokeStyle = Field(default_factory=StrokeStyle)
    fill: str | None = None
    keyframes: list[ObjectKeyframe] = Field(default_factory=list)


# Discriminated union of object variants, keyed on the ``type`` literal. Adding
# a variant later means: define the class with a unique ``type`` literal and add
# it to this union.
SceneObject = Annotated[
    Union[
        FreehandObject,
        TextObject,
        EquationObject,
        LineObject,
        ArrowObject,
        RectObject,
        EllipseObject,
        TriangleObject,
    ],
    Field(discriminator="type"),
]


# ---------------------------------------------------------------------------
# Keyframes
# ---------------------------------------------------------------------------


class ObjectProps(_Model):
    """Animatable properties of an object at a keyframe.

    All fields are optional: a keyframe only declares the properties it
    changes. ``position`` is an absolute offset (in canvas pixels) applied to
    the object's base geometry; ``scale``/``rotation`` are about the object's
    local origin. Interpolation between successive keyframes is linear in v1
    (easing curves slot in here later, e.g. an ``easing`` field on the
    enclosing keyframe).
    """

    # Translation offset from the object's authored position, in canvas px.
    position: list[float] | None = Field(default=None, min_length=2, max_length=2)
    # Uniform scale multiplier (1.0 = original size).
    scale: float | None = None
    # Rotation in degrees, clockwise in canvas (y-DOWN) space.
    rotation: float | None = None
    # 0..1 multiplier applied on top of the style's base opacity.
    opacity: float | None = Field(default=None, ge=0, le=1)


class ObjectKeyframe(_Model):
    """A per-object keyframe: a time and the props to reach at that time."""

    # Seconds from the start of the timeline.
    t: float = Field(ge=0)
    props: ObjectProps = Field(default_factory=ObjectProps)


class CameraKeyframe(_Model):
    """A camera keyframe: where the camera frame is centered and how zoomed.

    ``center`` is the canvas-pixel point (y-DOWN) the camera frame is centered
    on. ``zoom`` > 1 zooms in (frame covers less canvas), < 1 zooms out. The
    camera frame's aspect ratio is fixed by the output resolution (see
    ``docs/scene-schema.md``); only its center and zoom are keyframed.
    """

    t: float = Field(ge=0)
    center: list[float] = Field(min_length=2, max_length=2)
    zoom: float = Field(default=1.0, gt=0)


# Resolve the forward references now that ObjectKeyframe is defined. Every
# object variant references ``ObjectKeyframe`` for its ``keyframes`` field.
for _variant in (
    FreehandObject,
    TextObject,
    EquationObject,
    LineObject,
    ArrowObject,
    RectObject,
    EllipseObject,
    TriangleObject,
):
    _variant.model_rebuild()


# ---------------------------------------------------------------------------
# Timeline + top-level scene
# ---------------------------------------------------------------------------


class Timeline(_Model):
    """Timeline metadata."""

    duration_seconds: float = Field(alias="durationSeconds", gt=0)
    fps: int = Field(default=30, gt=0)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Camera(_Model):
    """The camera track: output resolution + its keyframes."""

    # Output video resolution in pixels; also fixes the camera frame aspect.
    width: int = Field(default=1920, gt=0)
    height: int = Field(default=1080, gt=0)
    keyframes: list[CameraKeyframe] = Field(default_factory=list)


class Scene(_Model):
    """Top-level scene payload: the full frontend↔backend↔agent contract."""

    schema_version: str = Field(default=SCHEMA_VERSION, alias="schemaVersion")
    timeline: Timeline
    camera: Camera
    objects: list[SceneObject] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
