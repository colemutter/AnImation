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
} from '../types/scene'

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
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 8

export const useSceneStore = create<SceneState>((set, get) => ({
  tool: 'draw',
  viewport: { offsetX: 0, offsetY: 0, zoom: 1 },
  strokeStyle: DEFAULT_STROKE,
  objects: [],
  draftPoints: null,

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

  clear: () => set({ objects: [], draftPoints: null }),
}))

/**
 * Typed selector for the current drawn objects. Use this (or
 * `useSceneStore.getState().objects`) wherever serialization needs the scene.
 */
export const selectObjects = (s: SceneState): SceneObject[] => s.objects
