/**
 * Geometry helpers shared by the canvas renderer + hit-tester for every
 * `SceneObject` variant (F2). Everything is in **authored** canvas px (y-DOWN),
 * i.e. before per-time keyframe transforms are applied — the keyframe
 * translate/scale/rotate is layered on top by the renderer via an SVG transform
 * about the returned `center`, exactly like freehand strokes.
 *
 * Two primitives:
 *  - `objectCenter` — the pivot used for scale/rotate (matches the freehand
 *    centroid convention).
 *  - `objectBounds` — an axis-aligned authored bounding box, used for the
 *    bounding-box hit test and the selection outline.
 */

import type { SceneObject } from '../types/scene'

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Authored axis-aligned bounding box of an object (canvas px, y-DOWN). */
export function objectBounds(obj: SceneObject): Bounds {
  switch (obj.type) {
    case 'freehand': {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const p of obj.points) {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
      }
      if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
      return { minX, minY, maxX, maxY }
    }
    case 'text':
    case 'equation': {
      // Approximate the text block extent from font size and content length.
      // Good enough for picking + the selection box; exact glyph metrics aren't
      // needed (and the backend re-lays-out the text anyway).
      const [x, y] = obj.position
      const content = obj.type === 'text' ? obj.text : obj.latex
      const len = Math.max(1, content.length)
      const w = len * obj.fontSize * 0.6
      const h = obj.fontSize * 1.2
      return { minX: x, minY: y, maxX: x + w, maxY: y + h }
    }
    case 'line':
    case 'arrow': {
      const [x0, y0] = obj.start
      const [x1, y1] = obj.end
      return {
        minX: Math.min(x0, x1),
        minY: Math.min(y0, y1),
        maxX: Math.max(x0, x1),
        maxY: Math.max(y0, y1),
      }
    }
    case 'rect': {
      const [x, y] = obj.position
      return { minX: x, minY: y, maxX: x + obj.width, maxY: y + obj.height }
    }
    case 'ellipse': {
      const [cx, cy] = obj.center
      return {
        minX: cx - obj.radiusX,
        minY: cy - obj.radiusY,
        maxX: cx + obj.radiusX,
        maxY: cy + obj.radiusY,
      }
    }
    case 'triangle': {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const [px, py] of obj.points) {
        if (px < minX) minX = px
        if (py < minY) minY = py
        if (px > maxX) maxX = px
        if (py > maxY) maxY = py
      }
      return { minX, minY, maxX, maxY }
    }
  }
}

/** Pivot (center) of an object in authored canvas px — used for scale/rotate. */
export function objectCenter(obj: SceneObject): { x: number; y: number } {
  if (obj.type === 'ellipse') {
    return { x: obj.center[0], y: obj.center[1] }
  }
  const b = objectBounds(obj)
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
}
