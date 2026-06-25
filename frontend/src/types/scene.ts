/**
 * Scene + animation schema — the frontend↔backend↔agent contract.
 *
 * These TypeScript types mirror the Pydantic v2 models in
 * `backend/schema.py`. Field names and shapes must match exactly (camelCase
 * on the wire: `schemaVersion`, `durationSeconds`).
 *
 * The animation model is keyframe-based: each object and the camera carries a
 * set of `(t, props)` keyframes that the timeline interpolates between.
 *
 * Coordinate convention: object geometry and camera positions are in **canvas
 * pixels with a y-DOWN axis** (the native browser canvas system). The
 * canvas→Manim (y-UP, world units) transform is defined once in
 * `docs/scene-schema.md` and applied by the codegen agent, not here.
 */

/** Bump deliberately when the shape changes (keep in sync with backend). */
export const SCHEMA_VERSION = '1.1.0' as const

/** A single 2D point in canvas pixel space (y-DOWN). */
export interface Point {
  x: number
  y: number
}

/** Visual style for a freehand stroke. */
export interface StrokeStyle {
  /** CSS color string, e.g. "#1e1e1e". */
  color: string
  /** Stroke width in canvas pixels (> 0). */
  width: number
  /** Base opacity, 0 (transparent)..1 (opaque). */
  opacity: number
}

/**
 * Animatable properties of an object at a keyframe. Every field is optional:
 * a keyframe only declares the properties it changes. Interpolation between
 * successive keyframes is linear in v1 (easing slots in later).
 */
export interface ObjectProps {
  /** Translation [dx, dy] from authored position, in canvas px. */
  position?: [number, number]
  /** Uniform scale multiplier (1.0 = original size). */
  scale?: number
  /** Rotation in degrees, clockwise in canvas (y-DOWN) space. */
  rotation?: number
  /** 0..1 multiplier applied on top of the style's base opacity. */
  opacity?: number
}

/** A per-object keyframe: a time (seconds) and the props to reach at it. */
export interface ObjectKeyframe {
  /** Seconds from the start of the timeline (>= 0). */
  t: number
  props: ObjectProps
}

/**
 * A freehand stroke: an ordered list of points plus stroke style. The original
 * v1 object variant; see the other variants below, each keyed on a distinct
 * `type` discriminant.
 */
export interface FreehandObject {
  id: string
  type: 'freehand'
  /** Ordered stroke points in canvas pixel space (y-DOWN), at least one. */
  points: Point[]
  style: StrokeStyle
  /** Per-object keyframes, sorted by `t` ascending. */
  keyframes: ObjectKeyframe[]
}

/**
 * A text box. `position` is the top-left anchor of the text block in canvas
 * pixels (y-DOWN). Maps to a Manim `Text` mobject.
 */
export interface TextObject {
  id: string
  type: 'text'
  /** Top-left anchor in canvas pixel space (y-DOWN). */
  position: [number, number]
  /** The text to render. */
  text: string
  /** Font size in canvas pixels. */
  fontSize: number
  /** CSS color string, e.g. "#1e1e1e". */
  color: string
  /** Per-object keyframes, sorted by `t` ascending. */
  keyframes: ObjectKeyframe[]
}

/**
 * A LaTeX equation box. `position` is the top-left anchor in canvas pixels
 * (y-DOWN). Maps to a Manim `MathTex` mobject (LaTeX must be provisioned).
 */
export interface EquationObject {
  id: string
  type: 'equation'
  /** Top-left anchor in canvas pixel space (y-DOWN). */
  position: [number, number]
  /** LaTeX source (math mode), e.g. "E = mc^2". */
  latex: string
  /** Font size in canvas pixels. */
  fontSize: number
  /** CSS color string, e.g. "#1e1e1e". */
  color: string
  /** Per-object keyframes, sorted by `t` ascending. */
  keyframes: ObjectKeyframe[]
}

/**
 * A straight line segment from `start` to `end` (canvas px, y-DOWN). Maps to a
 * Manim `Line` mobject.
 */
export interface LineObject {
  id: string
  type: 'line'
  /** Start point in canvas pixel space (y-DOWN). */
  start: [number, number]
  /** End point in canvas pixel space (y-DOWN). */
  end: [number, number]
  style: StrokeStyle
  /** Per-object keyframes, sorted by `t` ascending. */
  keyframes: ObjectKeyframe[]
}

/**
 * A straight arrow from `start` (tail) to `end` (head), canvas px (y-DOWN).
 * Maps to a Manim `Arrow` mobject.
 */
export interface ArrowObject {
  id: string
  type: 'arrow'
  /** Tail point in canvas pixel space (y-DOWN). */
  start: [number, number]
  /** Head point in canvas pixel space (y-DOWN). */
  end: [number, number]
  style: StrokeStyle
  /** Per-object keyframes, sorted by `t` ascending. */
  keyframes: ObjectKeyframe[]
}

/**
 * An axis-aligned rectangle. `position` is the top-left corner (canvas px,
 * y-DOWN); `width`/`height` extend right/down. Maps to a Manim `Rectangle`.
 */
export interface RectObject {
  id: string
  type: 'rect'
  /** Top-left corner in canvas pixel space (y-DOWN). */
  position: [number, number]
  /** Width in canvas pixels (extends to the right). */
  width: number
  /** Height in canvas pixels (extends downward). */
  height: number
  style: StrokeStyle
  /** Fill color (CSS string), or null/omitted for no fill. */
  fill?: string | null
  /** Per-object keyframes, sorted by `t` ascending. */
  keyframes: ObjectKeyframe[]
}

/**
 * An axis-aligned ellipse centered at `center` (canvas px, y-DOWN) with
 * horizontal/vertical radii. Maps to a Manim `Ellipse`.
 */
export interface EllipseObject {
  id: string
  type: 'ellipse'
  /** Center point in canvas pixel space (y-DOWN). */
  center: [number, number]
  /** Horizontal radius in canvas pixels. */
  radiusX: number
  /** Vertical radius in canvas pixels. */
  radiusY: number
  style: StrokeStyle
  /** Fill color (CSS string), or null/omitted for no fill. */
  fill?: string | null
  /** Per-object keyframes, sorted by `t` ascending. */
  keyframes: ObjectKeyframe[]
}

/**
 * A triangle defined by its three vertices (canvas px, y-DOWN). Maps to a
 * Manim `Polygon` (or `Triangle`) of the three points.
 */
export interface TriangleObject {
  id: string
  type: 'triangle'
  /** The three vertices in canvas pixel space (y-DOWN). */
  points: [[number, number], [number, number], [number, number]]
  style: StrokeStyle
  /** Fill color (CSS string), or null/omitted for no fill. */
  fill?: string | null
  /** Per-object keyframes, sorted by `t` ascending. */
  keyframes: ObjectKeyframe[]
}

/**
 * Discriminated union of object variants, keyed on `type`. Widen this union as
 * new variants land. Keyframes are shared across all variants (the same
 * `ObjectProps`: position delta / scale / rotation / opacity).
 */
export type SceneObject =
  | FreehandObject
  | TextObject
  | EquationObject
  | LineObject
  | ArrowObject
  | RectObject
  | EllipseObject
  | TriangleObject

/**
 * A camera keyframe: where the camera frame is centered (canvas px, y-DOWN)
 * and how zoomed (zoom > 1 zooms in). Frame aspect is fixed by the output
 * resolution; only center and zoom are keyframed.
 */
export interface CameraKeyframe {
  t: number
  center: [number, number]
  zoom: number
}

/** Timeline metadata. */
export interface Timeline {
  durationSeconds: number
  fps: number
}

/** The camera track: output resolution + its keyframes. */
export interface Camera {
  /** Output width in px; also fixes the camera frame aspect ratio. */
  width: number
  /** Output height in px. */
  height: number
  keyframes: CameraKeyframe[]
}

/** Top-level scene payload: the full frontend↔backend↔agent contract. */
export interface Scene {
  schemaVersion: string
  timeline: Timeline
  camera: Camera
  objects: SceneObject[]
}
