/**
 * Scene store (zustand) — the single source of truth for everything the user
 * draws. Drawn objects are kept in the exact wire shape from
 * `frontend/src/types/scene.ts`, so serialization for T2/T8 is free:
 *
 *     const objects = useSceneStore.getState().objects // SceneObject[]
 *
 * The store also owns the canvas viewport (pan offset + zoom) and the active
 * tool, plus an in-progress stroke buffer used while the pointer is down.
 *
 * EXTENSION POINT (T4 timeline): timeline metadata + a `currentTime` playhead
 * and per-object keyframe capture will live here. The schema already carries
 * `keyframes` on each object and `Timeline`/`Camera` types are imported below.
 *
 * EXTENSION POINT (T5 camera): camera keyframes + the camera-rectangle overlay
 * state (center, zoom, drag/resize) will live here, matching the `Camera` /
 * `CameraKeyframe` types from scene.ts.
 */

import { create } from 'zustand'
// Types come from the shared schema (owned by T2). If this import ever breaks
// because scene.ts changed shape, reconcile here rather than redefining types.
import type {
  Point,
  StrokeStyle,
  SceneObject,
  FreehandObject,
  ObjectProps,
  CameraKeyframe,
} from '../types/scene'
import { upsertKeyframe, interpolateKeyframes } from '../timeline/interpolate'

/** Tools available in the palette. Widen as shape/text/eraser tools land. */
export type Tool = 'select' | 'draw'

/** Screen<->world viewport transform. world = (screen - offset) / zoom. */
export interface Viewport {
  /** Pan offset in screen pixels. */
  offsetX: number
  offsetY: number
  /** Zoom factor (1 = 100%). */
  zoom: number
}

/** Default stroke style for new freehand strokes. */
const DEFAULT_STROKE: StrokeStyle = {
  color: '#1e1e1e',
  width: 4,
  opacity: 1,
}

let strokeCounter = 0
function nextStrokeId(): string {
  strokeCounter += 1
  return `stroke-${Date.now().toString(36)}-${strokeCounter}`
}

// --- camera (T5) ---------------------------------------------------------

/** Default output resolution; also fixes the camera frame aspect (16:9). */
const DEFAULT_CAMERA_WIDTH = 1920
const DEFAULT_CAMERA_HEIGHT = 1080

/** Min/max camera zoom (zoom > 1 = tighter frame = zoomed in). */
const MIN_CAM_ZOOM = 0.1
const MAX_CAM_ZOOM = 20

/** Resolved camera state at a point in time: where the frame sits + its zoom. */
export interface ResolvedCamera {
  /** Frame center in canvas px (y-DOWN). */
  center: [number, number]
  /** Zoom factor (> 1 zooms in / narrows the frame). */
  zoom: number
}

/** Linear interpolation between two scalars. */
function lerpN(a: number, b: number, f: number): number {
  return a + (b - a) * f
}

/**
 * Resolve the camera state at time `t` from a sorted `CameraKeyframe[]`. Mirrors
 * `interpolateKeyframes` for objects: **linear** between successive keyframes,
 * **hold/clamp** before the first and after the last. Falls back to `fallback`
 * (the live store camera) when there are no keyframes.
 */
export function interpolateCameraKeyframes(
  keyframes: CameraKeyframe[],
  t: number,
  fallback: ResolvedCamera,
): ResolvedCamera {
  if (!keyframes || keyframes.length === 0) return fallback
  if (keyframes.length === 1) {
    const k = keyframes[0]
    return { center: [k.center[0], k.center[1]], zoom: k.zoom }
  }
  // Before the first keyframe: hold at it.
  if (t <= keyframes[0].t) {
    const k = keyframes[0]
    return { center: [k.center[0], k.center[1]], zoom: k.zoom }
  }
  // After the last keyframe: hold at it.
  const last = keyframes[keyframes.length - 1]
  if (t >= last.t) return { center: [last.center[0], last.center[1]], zoom: last.zoom }
  // Find the bracketing pair (keyframes are sorted by t ascending).
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i]
    const b = keyframes[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const f = span <= 0 ? 0 : (t - a.t) / span
      return {
        center: [lerpN(a.center[0], b.center[0], f), lerpN(a.center[1], b.center[1], f)],
        zoom: lerpN(a.zoom, b.zoom, f),
      }
    }
  }
  return { center: [last.center[0], last.center[1]], zoom: last.zoom }
}

/**
 * Insert or update a camera keyframe at time `t`, replacing any keyframe at
 * (≈) the same time and keeping the list sorted by `t`. Returns a NEW array
 * (pure). This mirrors `upsertKeyframe` for objects — same capture pattern, on
 * the `CameraKeyframe` shape rather than `{ t, props }`.
 */
export function upsertCameraKeyframe(
  keyframes: CameraKeyframe[],
  t: number,
  center: [number, number],
  zoom: number,
  /** Times within this many seconds are treated as the same keyframe. */
  epsilon = 1e-4,
): CameraKeyframe[] {
  const next = keyframes.map((k) => ({ t: k.t, center: [k.center[0], k.center[1]] as [number, number], zoom: k.zoom }))
  const existing = next.find((k) => Math.abs(k.t - t) <= epsilon)
  if (existing) {
    existing.center = [center[0], center[1]]
    existing.zoom = zoom
  } else {
    next.push({ t, center: [center[0], center[1]], zoom })
    next.sort((a, b) => a.t - b.t)
  }
  return next
}

interface SceneState {
  /** Active tool. */
  tool: Tool
  /** Canvas viewport (pan + zoom). */
  viewport: Viewport
  /** Style applied to newly drawn strokes. */
  strokeStyle: StrokeStyle
  /**
   * Committed drawn objects, in wire shape. This is the serialization source:
   * `useSceneStore.getState().objects`.
   */
  objects: SceneObject[]
  /**
   * Points of the stroke currently being drawn (world coordinates), or null
   * when not drawing. Lives outside `objects` so the committed list stays clean.
   */
  draftPoints: Point[] | null

  // --- timeline state (T4) ---
  /** Total timeline length in seconds. Mirrors `Timeline.durationSeconds`. */
  durationSeconds: number
  /** Frames per second. Mirrors `Timeline.fps`. */
  fps: number
  /** Playhead position in seconds, clamped to [0, durationSeconds]. */
  currentTime: number
  /** True while the play/pause loop is advancing `currentTime`. */
  isPlaying: boolean
  /** Id of the currently selected object (for keyframe capture), or null. */
  selectedId: string | null
  /**
   * Live drag delta (canvas px) for the selected object, applied on top of its
   * resolved keyframe transform while dragging and not yet committed to a
   * keyframe. Null when not dragging an object.
   */
  liveDrag: { id: string; dx: number; dy: number } | null

  // --- camera state (T5) ---
  /** Output width in px; also fixes the camera frame aspect ratio. */
  cameraWidth: number
  /** Output height in px. */
  cameraHeight: number
  /**
   * Live camera frame center in canvas px (y-DOWN). This is the editable base
   * the overlay reads/writes; during scrub/play the overlay shows the
   * interpolated camera instead (see `interpolateCameraKeyframes`).
   */
  cameraCenter: [number, number]
  /** Live camera zoom (> 1 zooms in / narrows the frame). */
  cameraZoom: number
  /** Camera keyframes in `CameraKeyframe` shape, sorted by `t` ascending. */
  cameraKeyframes: CameraKeyframe[]
  /**
   * Live, uncommitted camera edit while dragging/resizing the frame, applied on
   * top of the resolved camera and not yet written to a keyframe. Null when not
   * editing the camera.
   */
  liveCamera: { center: [number, number]; zoom: number } | null

  // --- actions ---
  setTool: (tool: Tool) => void
  setViewport: (next: Partial<Viewport>) => void
  /** Pan by a screen-pixel delta. */
  panBy: (dx: number, dy: number) => void
  /**
   * Zoom toward a screen anchor point so the world point under the cursor stays
   * put. `factor` > 1 zooms in.
   */
  zoomAt: (screenX: number, screenY: number, factor: number) => void

  /** Begin a freehand stroke at a world-space point. */
  startStroke: (point: Point) => void
  /** Append a world-space point to the in-progress stroke. */
  appendPoint: (point: Point) => void
  /** Commit the in-progress stroke into `objects` (drops < 2 point strokes). */
  endStroke: () => void

  /** Remove every drawn object. */
  clear: () => void

  // --- timeline actions (T4) ---
  /** Set the playhead time (seconds); clamps to [0, durationSeconds]. */
  setCurrentTime: (t: number) => void
  /** Set timeline duration (seconds, > 0); re-clamps the playhead. */
  setDuration: (seconds: number) => void
  /** Start/stop/toggle the play loop. */
  setPlaying: (playing: boolean) => void
  togglePlaying: () => void

  /** Select an object (e.g. clicked with the select tool), or clear with null. */
  selectObject: (id: string | null) => void

  /**
   * Begin dragging the selected object at the current time. Pure bookkeeping —
   * the actual delta accumulates via `dragObjectBy`.
   */
  beginObjectDrag: (id: string) => void
  /** Accumulate a world-space delta onto the live object drag. */
  dragObjectBy: (dx: number, dy: number) => void
  /**
   * Commit the live drag as a position keyframe at `currentTime` for the
   * dragged object (merging onto the keyframe already at that time, if any).
   */
  endObjectDrag: () => void

  /**
   * Capture (upsert) a keyframe for an object at the given time. This is the
   * shared capture primitive: dragging uses it for `position`, and scale/
   * rotation/opacity flow through the same path. T5's camera reuses this same
   * upsert pattern on its own keyframe array.
   */
  captureKeyframe: (id: string, t: number, props: ObjectProps) => void

  // --- camera actions (T5) ---
  /**
   * Begin editing the camera frame (drag or resize). Seeds `liveCamera` from the
   * resolved camera at the current time so the edit is relative to wherever the
   * frame sits now. Stops playback (editing while playing makes no sense).
   */
  beginCameraEdit: () => void
  /**
   * Update the live camera edit. `center` is the new frame center (canvas px);
   * `zoom` the new zoom. Both default to the current live values when omitted.
   */
  dragCamera: (next: { center?: [number, number]; zoom?: number }) => void
  /**
   * Commit the live camera edit as a camera keyframe at `currentTime`, reusing
   * the same upsert pattern T4 uses for objects (mirrored on `cameraKeyframes`).
   * Also updates the live `cameraCenter`/`cameraZoom` base.
   */
  endCameraEdit: () => void
  /** Resolve the camera (center + zoom) at the given time. */
  resolveCameraAt: (t: number) => ResolvedCamera
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 8

/** Default timeline length/fps; mirrors the schema's example values. */
const DEFAULT_DURATION = 5
const DEFAULT_FPS = 30

export const useSceneStore = create<SceneState>((set, get) => ({
  tool: 'draw',
  viewport: { offsetX: 0, offsetY: 0, zoom: 1 },
  strokeStyle: DEFAULT_STROKE,
  objects: [],
  draftPoints: null,

  durationSeconds: DEFAULT_DURATION,
  fps: DEFAULT_FPS,
  currentTime: 0,
  isPlaying: false,
  selectedId: null,
  liveDrag: null,

  cameraWidth: DEFAULT_CAMERA_WIDTH,
  cameraHeight: DEFAULT_CAMERA_HEIGHT,
  // Default: frame centered on the output-resolution center, zoom 1. This puts
  // the frame around the canvas origin region where the first strokes land.
  cameraCenter: [DEFAULT_CAMERA_WIDTH / 2, DEFAULT_CAMERA_HEIGHT / 2],
  cameraZoom: 1,
  cameraKeyframes: [],
  liveCamera: null,

  setTool: (tool) => set({ tool }),

  setViewport: (next) =>
    set((s) => ({ viewport: { ...s.viewport, ...next } })),

  panBy: (dx, dy) =>
    set((s) => ({
      viewport: {
        ...s.viewport,
        offsetX: s.viewport.offsetX + dx,
        offsetY: s.viewport.offsetY + dy,
      },
    })),

  zoomAt: (screenX, screenY, factor) =>
    set((s) => {
      const { offsetX, offsetY, zoom } = s.viewport
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor))
      // World point currently under the cursor.
      const worldX = (screenX - offsetX) / zoom
      const worldY = (screenY - offsetY) / zoom
      // Keep that world point anchored under the cursor after zooming.
      return {
        viewport: {
          zoom: nextZoom,
          offsetX: screenX - worldX * nextZoom,
          offsetY: screenY - worldY * nextZoom,
        },
      }
    }),

  startStroke: (point) => set({ draftPoints: [point] }),

  appendPoint: (point) =>
    set((s) =>
      s.draftPoints ? { draftPoints: [...s.draftPoints, point] } : {},
    ),

  endStroke: () => {
    const draft = get().draftPoints
    if (!draft || draft.length < 2) {
      set({ draftPoints: null })
      return
    }
    const stroke: FreehandObject = {
      id: nextStrokeId(),
      type: 'freehand',
      points: draft,
      style: { ...get().strokeStyle },
      keyframes: [], // EXTENSION POINT (T4): motion keyframes captured here.
    }
    set((s) => ({ objects: [...s.objects, stroke], draftPoints: null }))
  },

  clear: () =>
    set({
      objects: [],
      draftPoints: null,
      selectedId: null,
      liveDrag: null,
      isPlaying: false,
    }),

  // --- timeline actions (T4) ---

  setCurrentTime: (t) =>
    set((s) => ({
      currentTime: Math.min(s.durationSeconds, Math.max(0, t)),
    })),

  setDuration: (seconds) =>
    set((s) => {
      const dur = Math.max(0.1, seconds)
      return {
        durationSeconds: dur,
        currentTime: Math.min(dur, s.currentTime),
      }
    }),

  setPlaying: (playing) => set({ isPlaying: playing }),

  togglePlaying: () => set((s) => ({ isPlaying: !s.isPlaying })),

  selectObject: (id) => set({ selectedId: id }),

  beginObjectDrag: (id) =>
    set({ selectedId: id, liveDrag: { id, dx: 0, dy: 0 }, isPlaying: false }),

  dragObjectBy: (dx, dy) =>
    set((s) =>
      s.liveDrag
        ? {
            liveDrag: {
              ...s.liveDrag,
              dx: s.liveDrag.dx + dx,
              dy: s.liveDrag.dy + dy,
            },
          }
        : {},
    ),

  endObjectDrag: () => {
    const { liveDrag, objects, currentTime } = get()
    if (!liveDrag) return
    const obj = objects.find((o) => o.id === liveDrag.id)
    if (!obj || (liveDrag.dx === 0 && liveDrag.dy === 0)) {
      set({ liveDrag: null })
      return
    }
    // The committed position is the resolved keyframe position at this time
    // (the object's animated base) plus the live drag delta. This makes a drag
    // edit relative to wherever the object already sits at `currentTime`.
    const base = interpolateKeyframes(obj.keyframes, currentTime).position
    const position: [number, number] = [
      base[0] + liveDrag.dx,
      base[1] + liveDrag.dy,
    ]
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === liveDrag.id
          ? { ...o, keyframes: upsertKeyframe(o.keyframes, currentTime, { position }) }
          : o,
      ),
      liveDrag: null,
    }))
  },

  captureKeyframe: (id, t, props) =>
    set((s) => ({
      objects: s.objects.map((o) =>
        o.id === id
          ? { ...o, keyframes: upsertKeyframe(o.keyframes, t, props) }
          : o,
      ),
    })),

  // --- camera actions (T5) ---

  beginCameraEdit: () => {
    const { cameraKeyframes, currentTime, cameraCenter, cameraZoom } = get()
    // Seed the live edit from the resolved camera at the current time, so a
    // drag/resize starts from wherever the frame currently sits.
    const resolved = interpolateCameraKeyframes(cameraKeyframes, currentTime, {
      center: cameraCenter,
      zoom: cameraZoom,
    })
    set({
      isPlaying: false,
      liveCamera: { center: [resolved.center[0], resolved.center[1]], zoom: resolved.zoom },
    })
  },

  dragCamera: (next) =>
    set((s) => {
      if (!s.liveCamera) return {}
      const center = next.center ?? s.liveCamera.center
      const zoom =
        next.zoom !== undefined
          ? Math.min(MAX_CAM_ZOOM, Math.max(MIN_CAM_ZOOM, next.zoom))
          : s.liveCamera.zoom
      return { liveCamera: { center: [center[0], center[1]], zoom } }
    }),

  endCameraEdit: () => {
    const { liveCamera, cameraKeyframes, currentTime } = get()
    if (!liveCamera) return
    // Commit as a camera keyframe at the current time (same upsert pattern T4
    // uses for objects, mirrored on the CameraKeyframe array), and advance the
    // live base so the frame stays put after the edit.
    set({
      cameraKeyframes: upsertCameraKeyframe(
        cameraKeyframes,
        currentTime,
        liveCamera.center,
        liveCamera.zoom,
      ),
      cameraCenter: [liveCamera.center[0], liveCamera.center[1]],
      cameraZoom: liveCamera.zoom,
      liveCamera: null,
    })
  },

  resolveCameraAt: (t) => {
    const { cameraKeyframes, cameraCenter, cameraZoom, liveCamera } = get()
    // While actively editing, show the live (uncommitted) frame.
    if (liveCamera) return { center: [liveCamera.center[0], liveCamera.center[1]], zoom: liveCamera.zoom }
    return interpolateCameraKeyframes(cameraKeyframes, t, {
      center: cameraCenter,
      zoom: cameraZoom,
    })
  },
}))

/**
 * Typed selector for the current drawn objects. Use this (or
 * `useSceneStore.getState().objects`) wherever serialization needs the scene.
 */
export const selectObjects = (s: SceneState): SceneObject[] => s.objects

// Dev-only: expose the store on window for scripted debugging / e2e checks
// (used by integration verification; harmless in dev, stripped from prod use).
if (import.meta.env.DEV) {
  ;(window as unknown as { __sceneStore?: typeof useSceneStore }).__sceneStore =
    useSceneStore
}
