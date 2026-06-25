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
import type { FreehandObject } from '../types/scene'

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

  const startStroke = useSceneStore((s) => s.startStroke)
  const appendPoint = useSceneStore((s) => s.appendPoint)
  const endStroke = useSceneStore((s) => s.endStroke)
  const panBy = useSceneStore((s) => s.panBy)
  const zoomAt = useSceneStore((s) => s.zoomAt)
  const setTool = useSceneStore((s) => s.setTool)

  // Track the live gesture without re-rendering on every move.
  const gesture = useRef<{
    mode: 'draw' | 'pan' | null
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

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const { sx, sy } = localPoint(e)
      const wantPan =
        spaceHeld || e.button === 1 || (tool === 'select' && e.button === 0)
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
    [localPoint, spaceHeld, tool, startStroke, viewport],
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
      } else {
        appendPoint(screenToWorld(sx, sy, viewport))
      }
    },
    [localPoint, panBy, appendPoint, viewport],
  )

  const endGesture = useCallback(
    (e: React.PointerEvent) => {
      const g = gesture.current
      if (!g.mode) return
      if (g.mode === 'draw') endStroke()
      g.mode = null
      ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    },
    [endStroke],
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
          <StrokePath key={obj.id} obj={obj} />
        ))}

        {/* In-progress stroke, drawn with the active style. */}
        {draftPoints && draftPoints.length > 0 && (
          <path
            d={strokeToPath(draftPoints, strokeStyle)}
            fill={strokeStyle.color}
            fillOpacity={strokeStyle.opacity}
          />
        )}

        {/* EXTENSION POINT (T5 camera): camera rectangle overlay goes here,
            inside the world transform so it tracks pan/zoom. */}
      </g>

      {/* EXTENSION POINT (T4 timeline): the bottom timeline bar is rendered as
          a sibling DOM overlay in App.tsx, not inside the SVG world group. */}
    </svg>
  )
}

function StrokePath({ obj }: { obj: FreehandObject }) {
  const d = strokeToPath(obj.points, obj.style)
  return <path d={d} fill={obj.style.color} fillOpacity={obj.style.opacity} />
}
