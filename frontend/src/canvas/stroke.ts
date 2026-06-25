/**
 * Stroke geometry helpers: turn an ordered list of points into a filled SVG
 * path using `perfect-freehand`, and convert screen<->world coordinates.
 */

import { getStroke } from 'perfect-freehand'
import type { Point, StrokeStyle } from '../types/scene'
import type { Viewport } from '../store/sceneStore'

/** Screen pixel -> world coordinate, given the viewport transform. */
export function screenToWorld(
  screenX: number,
  screenY: number,
  v: Viewport,
): Point {
  return {
    x: (screenX - v.offsetX) / v.zoom,
    y: (screenY - v.offsetY) / v.zoom,
  }
}

/** World coordinate -> screen pixel, given the viewport transform. */
export function worldToScreen(
  worldX: number,
  worldY: number,
  v: Viewport,
): { x: number; y: number } {
  return {
    x: worldX * v.zoom + v.offsetX,
    y: worldY * v.zoom + v.offsetY,
  }
}

/**
 * Build an SVG path `d` string for a freehand stroke. Points are in WORLD
 * space; the caller draws them under the viewport transform, so `width` is the
 * world-space stroke width (zoom is applied by the canvas transform).
 */
export function strokeToPath(points: Point[], style: StrokeStyle): string {
  if (points.length === 0) return ''
  const outline = getStroke(
    points.map((p) => [p.x, p.y]),
    {
      size: style.width,
      thinning: 0.5,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: true,
    },
  )
  if (outline.length === 0) return ''
  return outlineToSvgPath(outline)
}

/** Convert a perfect-freehand outline (array of [x, y]) to an SVG path. */
function outlineToSvgPath(outline: number[][]): string {
  const d = outline.reduce<string[]>((acc, [x0, y0], i, arr) => {
    const [x1, y1] = arr[(i + 1) % arr.length]
    acc.push(
      `${x0.toFixed(2)},${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(2)},${(
        (y0 + y1) / 2
      ).toFixed(2)}`,
    )
    return acc
  }, [])
  return `M ${d[0]} Q ${d.slice(1).join(' ')} Z`
}
