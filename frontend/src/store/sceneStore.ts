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
