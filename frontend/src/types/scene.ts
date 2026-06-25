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
export const SCHEMA_VERSION = '1.0.0' as const

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
 * A freehand stroke: an ordered list of points plus stroke style. The only
 * object variant in v1. rect/line/text are added later as new members of the
 * `SceneObject` union, each with a distinct `type` discriminant.
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
 * Discriminated union of object variants, keyed on `type`. Today just
 * `FreehandObject`; widen this union (e.g. `FreehandObject | RectObject`) as
 * new variants land.
 */
export type SceneObject = FreehandObject

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
