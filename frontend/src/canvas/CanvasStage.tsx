/**
 * Infinite, pannable/zoomable canvas with a working freehand draw tool.
 *
 * Rendering: a single full-viewport <svg>. All world content lives inside one
 * <g> with a `translate(offset) scale(zoom)` transform, so screen<->world is a
 * single shared transform (see store `viewport` + `canvas/stroke.ts`). This is
 * what makes the T4 timeline and T5 camera overlay cheap: they are plain DOM /
 * SVG positioned with the same transform.
 *
 * Interaction:
 *  - Draw tool: pointer drag paints a freehand stroke into the store.
 *  - Select/pan tool: pointer drag pans. Space-held or middle-mouse pans in any
 *    tool. Wheel = zoom toward cursor (ctrl/cmd or plain wheel), shift+wheel or
 *    plain wheel without zoom-intent pans.
 *
 * EXTENSION POINT (T5 camera): render the draggable camera rectangle as an
 * element inside the world <g> (so it tracks pan/zoom) or as a screen-space
 * overlay converted via worldToScreen(). Hook its state into the store.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSceneStore } from '../store/sceneStore'
import { screenToWorld, strokeToPath } from './stroke'
import { interpolateKeyframes } from '../timeline/interpolate'
import { CameraOverlay } from './CameraOverlay'
import type { FreehandObject } from '../types/scene'

/** Centroid (in world px) of a stroke's points — the pivot for scale/rotate. */
function strokeCentroid(obj: FreehandObject): { x: number; y: number } {
  const n = obj.points.length || 1
  let sx = 0
  let sy = 0
  for (const p of obj.points) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / n, y: sy / n }
}

/** Spacing of the background dot grid in world units. */
const GRID_SIZE = 32

export function CanvasStage() {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)

  const tool = useSceneStore((s) => s.tool)
  const viewport = useSceneStore((s) => s.viewport)
  const objects = useSceneStore((s) => s.objects)
  const draftPoints = useSceneStore((s) => s.draftPoints)
  const strokeStyle = useSceneStore((s) => s.strokeStyle)
  const currentTime = useSceneStore((s) => s.currentTime)
  const selectedId = useSceneStore((s) => s.selectedId)
  const liveDrag = useSceneStore((s) => s.liveDrag)

  const startStroke = useSceneStore((s) => s.startStroke)
  const appendPoint = useSceneStore((s) => s.appendPoint)
  const endStroke = useSceneStore((s) => s.endStroke)
  const panBy = useSceneStore((s) => s.panBy)
  const zoomAt = useSceneStore((s) => s.zoomAt)
  const setTool = useSceneStore((s) => s.setTool)
  const selectObject = useSceneStore((s) => s.selectObject)
  const beginObjectDrag = useSceneStore((s) => s.beginObjectDrag)
  const dragObjectBy = useSceneStore((s) => s.dragObjectBy)
  const endObjectDrag = useSceneStore((s) => s.endObjectDrag)

  // Track the live gesture without re-rendering on every move.
  const gesture = useRef<{
    mode: 'draw' | 'pan' | 'object' | null
    lastX: number
    lastY: number
  }>({ mode: null, lastX: 0, lastY: 0 })

  // Keep the SVG sized to its container.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    setSize({ w: r.width, h: r.height })
    return () => ro.disconnect()
  }, [])

  // Keyboard: space-to-pan, tool hotkeys.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(true)
      if (e.key === 'd' || e.key === 'D') setTool('draw')
      if (e.key === 'v' || e.key === 'V') setTool('select')
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [setTool])

  const localPoint = useCallback((e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top }
  }, [])

  /**
   * Hit-test the topmost object under a world point. Compares against each
   * object's RESOLVED position (authored centroid + interpolated keyframe
   * translation at `currentTime`), within a zoom-aware radius. Returns the
   * object id or null. Last drawn wins (iterate in reverse).
   */
  const hitTest = useCallback(
    (worldX: number, worldY: number): string | null => {
      // Generous pick radius in world px (so thin strokes are still grabbable).
      const r = 24 / viewport.zoom
      for (let i = objects.length - 1; i >= 0; i--) {
        const obj = objects[i]
        const { position } = interpolateKeyframes(obj.keyframes, currentTime)
        for (const p of obj.points) {
          const dx = p.x + position[0] - worldX
          const dy = p.y + position[1] - worldY
          if (dx * dx + dy * dy <= r * r) return obj.id
        }
      }
      return null
    },
    [objects, currentTime, viewport.zoom],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const { sx, sy } = localPoint(e)

      // Select tool, primary button, no pan modifier: try to grab an object.
      if (tool === 'select' && e.button === 0 && !spaceHeld) {
        const world = screenToWorld(sx, sy, viewport)
        const hitId = hitTest(world.x, world.y)
        ;(e.target as Element).setPointerCapture?.(e.pointerId)
        gesture.current.lastX = sx
        gesture.current.lastY = sy
        if (hitId) {
          gesture.current.mode = 'object'
          beginObjectDrag(hitId)
        } else {
          gesture.current.mode = 'pan'
          selectObject(null)
        }
        return
      }

      const wantPan = spaceHeld || e.button === 1
      const wantDraw = tool === 'draw' && e.button === 0 && !spaceHeld
      if (!wantPan && !wantDraw) return

      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      gesture.current.lastX = sx
      gesture.current.lastY = sy

      if (wantPan) {
        gesture.current.mode = 'pan'
      } else {
        gesture.current.mode = 'draw'
        startStroke(screenToWorld(sx, sy, viewport))
      }
    },
    [
      localPoint,
      spaceHeld,
      tool,
      startStroke,
      viewport,
      hitTest,
      beginObjectDrag,
      selectObject,
    ],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const g = gesture.current
      if (!g.mode) return
      const { sx, sy } = localPoint(e)
      if (g.mode === 'pan') {
        panBy(sx - g.lastX, sy - g.lastY)
        g.lastX = sx
        g.lastY = sy
      } else if (g.mode === 'object') {
        // Convert the screen delta to a world delta (drag in world units so the
        // captured keyframe position is in canvas px, matching the schema).
        dragObjectBy((sx - g.lastX) / viewport.zoom, (sy - g.lastY) / viewport.zoom)
        g.lastX = sx
        g.lastY = sy
      } else {
        appendPoint(screenToWorld(sx, sy, viewport))
      }
    },
    [localPoint, panBy, appendPoint, dragObjectBy, viewport],
  )

  const endGesture = useCallback(
    (e: React.PointerEvent) => {
      const g = gesture.current
      if (!g.mode) return
      if (g.mode === 'draw') endStroke()
      if (g.mode === 'object') endObjectDrag()
      g.mode = null
      ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    },
    [endStroke, endObjectDrag],
  )

  // Wheel: ctrl/cmd or pinch -> zoom toward cursor; otherwise pan.
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const { sx, sy } = (() => {
        const rect = svgRef.current!.getBoundingClientRect()
        return { sx: e.clientX - rect.left, sy: e.clientY - rect.top }
      })()
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01)
        zoomAt(sx, sy, factor)
      } else {
        panBy(-e.deltaX, -e.deltaY)
      }
    },
    [panBy, zoomAt],
  )

  const transform = `translate(${viewport.offsetX} ${viewport.offsetY}) scale(${viewport.zoom})`

  // Background dot grid sized to the visible world rect.
  const grid = useMemo(() => {
    if (size.w === 0) return null
    const topLeft = screenToWorld(0, 0, viewport)
    const bottomRight = screenToWorld(size.w, size.h, viewport)
    const startX = Math.floor(topLeft.x / GRID_SIZE) * GRID_SIZE
    const startY = Math.floor(topLeft.y / GRID_SIZE) * GRID_SIZE
    const dots: { x: number; y: number }[] = []
    // Cap dot count so very zoomed-out views stay cheap.
    const cols = (bottomRight.x - startX) / GRID_SIZE
    const rows = (bottomRight.y - startY) / GRID_SIZE
    if (cols * rows > 6000) return null
    for (let x = startX; x <= bottomRight.x; x += GRID_SIZE) {
      for (let y = startY; y <= bottomRight.y; y += GRID_SIZE) {
        dots.push({ x, y })
      }
    }
    return dots
  }, [size, viewport])

  const cursor =
    spaceHeld || tool === 'select' ? 'grab' : 'crosshair'

  return (
    <svg
      ref={svgRef}
      className="canvas-stage"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onWheel={onWheel}
    >
      <g transform={transform}>
        {grid && (
          <g className="canvas-grid">
            {grid.map((d, i) => (
              <circle key={i} cx={d.x} cy={d.y} r={1 / viewport.zoom} />
            ))}
          </g>
        )}

        {objects.map((obj) => (
          <StrokePath
            key={obj.id}
            obj={obj}
            time={currentTime}
            selected={obj.id === selectedId}
            // Live, uncommitted drag delta for the object being dragged.
            live={liveDrag && liveDrag.id === obj.id ? liveDrag : null}
          />
        ))}

        {/* In-progress stroke, drawn with the active style. */}
        {draftPoints && draftPoints.length > 0 && (
          <path
            d={strokeToPath(draftPoints, strokeStyle)}
            fill={strokeStyle.color}
            fillOpacity={strokeStyle.opacity}
          />
        )}

        {/* T5 camera: the draggable/resizable camera viewport indicator. Lives
            inside the world transform so it pans/zooms with the scene, and
            interpolates between camera keyframes for `currentTime`. */}
        <CameraOverlay time={currentTime} />
      </g>

      {/* EXTENSION POINT (T4 timeline): the bottom timeline bar is rendered as
          a sibling DOM overlay in App.tsx, not inside the SVG world group. */}
    </svg>
  )
}

/**
 * One drawn stroke, rendered at its interpolated state for `time`. The authored
 * path is built once; the per-time transform (translate + rotate/scale about the
 * stroke centroid) is applied via an SVG `transform` so scrubbing/playing only
 * changes the wrapper, not the path geometry. A live drag delta (the object
 * being dragged, not yet committed to a keyframe) is added on top.
 */
function StrokePath({
  obj,
  time,
  selected,
  live,
}: {
  obj: FreehandObject
  time: number
  selected: boolean
  live: { dx: number; dy: number } | null
}) {
  const d = useMemo(() => strokeToPath(obj.points, obj.style), [obj.points, obj.style])
  const resolved = interpolateKeyframes(obj.keyframes, time)
  const c = strokeCentroid(obj)
  const tx = resolved.position[0] + (live ? live.dx : 0)
  const ty = resolved.position[1] + (live ? live.dy : 0)
  // Order: translate to keyframe position, then scale/rotate about the centroid.
  const transform =
    `translate(${tx} ${ty}) ` +
    `translate(${c.x} ${c.y}) ` +
    `rotate(${resolved.rotation}) ` +
    `scale(${resolved.scale}) ` +
    `translate(${-c.x} ${-c.y})`
  return (
    <g transform={transform} opacity={resolved.opacity}>
      <path d={d} fill={obj.style.color} fillOpacity={obj.style.opacity} />
      {selected && (
        <path
          d={d}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeOpacity={0.9}
          className="stroke-selected-outline"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </g>
  )
}
