/**
 * Infinite, pannable/zoomable canvas with freehand draw plus the F2 drawing
 * primitives (text, equation, line, arrow, rect, ellipse, triangle).
 *
 * Rendering: a single full-viewport <svg>. All world content lives inside one
 * <g> with a `translate(offset) scale(zoom)` transform, so screen<->world is a
 * single shared transform (see store `viewport` + `canvas/stroke.ts`). This is
 * what makes the T4 timeline and T5 camera overlay cheap: they are plain DOM /
 * SVG positioned with the same transform.
 *
 * Interaction:
 *  - Draw tool: pointer drag paints a freehand stroke into the store.
 *  - Text / Equation tools: click to place an object, then an inline HTML field
 *    (rendered as an overlay) to type its content; commit on blur/Enter.
 *  - Line / Arrow / Rect / Ellipse / Triangle tools: pointer drag defines the
 *    geometry (start→end or a bounding box), committed on pointer-up. After
 *    creating, the tool switches back to select so the new object is editable.
 *  - Select/pan tool: pointer drag pans, or grabs+drags an object to capture a
 *    position keyframe. Space-held or middle-mouse pans in any tool. Wheel =
 *    zoom toward cursor (ctrl/cmd) or pan.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSceneStore } from '../store/sceneStore'
import { screenToWorld, strokeToPath, worldToScreen } from './stroke'
import { interpolateKeyframes } from '../timeline/interpolate'
import { objectBounds } from './objectGeometry'
import { SceneObjectView } from './SceneObjectView'
import { CameraOverlay } from './CameraOverlay'
import type {
  FreehandObject,
  SceneObject,
  StrokeStyle,
  TextObject,
  EquationObject,
  LineObject,
  ArrowObject,
  RectObject,
  EllipseObject,
  TriangleObject,
} from '../types/scene'

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

/** Tools that build their object by dragging a start→end / bounding box. */
type DragTool = 'line' | 'arrow' | 'rect' | 'ellipse' | 'triangle'
const DRAG_TOOLS: DragTool[] = ['line', 'arrow', 'rect', 'ellipse', 'triangle']
function isDragTool(t: string): t is DragTool {
  return (DRAG_TOOLS as string[]).includes(t)
}

export function CanvasStage() {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  // In-progress shape drag (world coords), for line/arrow/rect/ellipse/triangle.
  const [draftShape, setDraftShape] = useState<
    | { tool: DragTool; start: { x: number; y: number }; end: { x: number; y: number } }
    | null
  >(null)

  const tool = useSceneStore((s) => s.tool)
  const viewport = useSceneStore((s) => s.viewport)
  const objects = useSceneStore((s) => s.objects)
  const draftPoints = useSceneStore((s) => s.draftPoints)
  const strokeStyle = useSceneStore((s) => s.strokeStyle)
  const currentTime = useSceneStore((s) => s.currentTime)
  const selectedId = useSceneStore((s) => s.selectedId)
  const editingId = useSceneStore((s) => s.editingId)
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
  const addObject = useSceneStore((s) => s.addObject)
  const addTextAt = useSceneStore((s) => s.addTextAt)
  const addEquationAt = useSceneStore((s) => s.addEquationAt)

  // Track the live gesture without re-rendering on every move.
  const gesture = useRef<{
    mode: 'draw' | 'pan' | 'object' | 'shape' | null
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

  // Keyboard: space-to-pan, tool hotkeys. Ignore while typing in an input.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    }
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(true)
      if (typing(e)) return
      const k = e.key.toLowerCase()
      if (k === 'd') setTool('draw')
      else if (k === 'v') setTool('select')
      else if (k === 't') setTool('text')
      else if (k === 'l') setTool('line')
      else if (k === 'a') setTool('arrow')
      else if (k === 'r') setTool('rect')
      else if (k === 'o') setTool('ellipse')
      else if (k === 'e') setTool('equation')
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
   * Hit-test the topmost object under a world point. For freehand it tests
   * proximity to the stroke points (as before); for every other variant it uses
   * the object's resolved (keyframe-translated) bounding box. Last drawn wins.
   */
  const hitTest = useCallback(
    (worldX: number, worldY: number): string | null => {
      const r = 24 / viewport.zoom
      for (let i = objects.length - 1; i >= 0; i--) {
        const obj = objects[i]
        const { position } = interpolateKeyframes(obj.keyframes, currentTime)
        if (obj.type === 'freehand') {
          for (const p of obj.points) {
            const dx = p.x + position[0] - worldX
            const dy = p.y + position[1] - worldY
            if (dx * dx + dy * dy <= r * r) return obj.id
          }
          continue
        }
        // Bounding-box pick (padded so thin shapes stay grabbable), shifted by
        // the resolved keyframe translation at the current time.
        const b = objectBounds(obj)
        const pad = 6 / viewport.zoom
        const minX = b.minX + position[0] - pad
        const minY = b.minY + position[1] - pad
        const maxX = b.maxX + position[0] + pad
        const maxY = b.maxY + position[1] + pad
        if (worldX >= minX && worldX <= maxX && worldY >= minY && worldY <= maxY) {
          return obj.id
        }
      }
      return null
    },
    [objects, currentTime, viewport.zoom],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const { sx, sy } = localPoint(e)
      const world = screenToWorld(sx, sy, viewport)

      // Select tool, primary button, no pan modifier: try to grab an object.
      if (tool === 'select' && e.button === 0 && !spaceHeld) {
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
      if (wantPan) {
        ;(e.target as Element).setPointerCapture?.(e.pointerId)
        gesture.current.mode = 'pan'
        gesture.current.lastX = sx
        gesture.current.lastY = sy
        return
      }

      if (e.button !== 0) return

      // Click-to-place tools (text / equation).
      if (tool === 'text') {
        addTextAt(world.x, world.y)
        setTool('select')
        return
      }
      if (tool === 'equation') {
        addEquationAt(world.x, world.y)
        setTool('select')
        return
      }

      // Drag-to-define tools (line / arrow / rect / ellipse / triangle).
      if (isDragTool(tool)) {
        ;(e.target as Element).setPointerCapture?.(e.pointerId)
        gesture.current.mode = 'shape'
        gesture.current.lastX = sx
        gesture.current.lastY = sy
        setDraftShape({ tool, start: world, end: world })
        return
      }

      // Freehand draw.
      if (tool === 'draw') {
        ;(e.target as Element).setPointerCapture?.(e.pointerId)
        gesture.current.mode = 'draw'
        gesture.current.lastX = sx
        gesture.current.lastY = sy
        startStroke(world)
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
      addTextAt,
      addEquationAt,
      setTool,
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
        dragObjectBy((sx - g.lastX) / viewport.zoom, (sy - g.lastY) / viewport.zoom)
        g.lastX = sx
        g.lastY = sy
      } else if (g.mode === 'shape') {
        const world = screenToWorld(sx, sy, viewport)
        setDraftShape((d) => (d ? { ...d, end: world } : d))
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
      if (g.mode === 'shape') {
        setDraftShape((d) => {
          if (d) {
            const obj = buildShape(d.tool, d.start, d.end, strokeStyle)
            if (obj) {
              addObject(obj)
              setTool('select')
            }
          }
          return null
        })
      }
      g.mode = null
      ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    },
    [endStroke, endObjectDrag, addObject, setTool, strokeStyle],
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
    spaceHeld || tool === 'select' ? 'grab' : tool === 'text' ? 'text' : 'crosshair'

  // The object whose inline editor is open (text or equation).
  const editingObj = editingId
    ? (objects.find(
        (o): o is TextObject | EquationObject =>
          o.id === editingId && (o.type === 'text' || o.type === 'equation'),
      ) ?? undefined)
    : undefined

  return (
    <>
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

          {objects.map((obj) =>
            obj.type === 'freehand' ? (
              <StrokePath
                key={obj.id}
                obj={obj}
                time={currentTime}
                selected={obj.id === selectedId}
                live={liveDrag && liveDrag.id === obj.id ? liveDrag : null}
              />
            ) : (
              <SceneObjectView
                key={obj.id}
                obj={obj}
                time={currentTime}
                selected={obj.id === selectedId}
                live={liveDrag && liveDrag.id === obj.id ? liveDrag : null}
                zoom={viewport.zoom}
              />
            ),
          )}

          {/* In-progress freehand stroke, drawn with the active style. */}
          {draftPoints && draftPoints.length > 0 && (
            <path
              d={strokeToPath(draftPoints, strokeStyle)}
              fill={strokeStyle.color}
              fillOpacity={strokeStyle.opacity}
            />
          )}

          {/* In-progress shape preview (line/arrow/rect/ellipse/triangle). */}
          {draftShape && (
            <DraftShapePreview draft={draftShape} style={strokeStyle} />
          )}

          {/* T5 camera viewport indicator. */}
          <CameraOverlay time={currentTime} />
        </g>
      </svg>

      {/* Inline editor overlay for the text/equation object being typed. It is a
          screen-space HTML input positioned via worldToScreen so it tracks pan/
          zoom; it lives outside the SVG so the native caret/IME work. */}
      {editingObj && (
        <InlineTextEditor key={editingObj.id} obj={editingObj} viewport={viewport} />
      )}
    </>
  )
}

/** Build a finished shape object from a drag start→end + the active style. */
function buildShape(
  tool: DragTool,
  start: { x: number; y: number },
  end: { x: number; y: number },
  style: StrokeStyle,
): SceneObject | null {
  const id = `${tool}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`
  const s: StrokeStyle = { ...style }
  if (tool === 'line') {
    const obj: LineObject = {
      id,
      type: 'line',
      start: [start.x, start.y],
      end: [end.x, end.y],
      style: s,
      keyframes: [],
    }
    return obj
  }
  if (tool === 'arrow') {
    const obj: ArrowObject = {
      id,
      type: 'arrow',
      start: [start.x, start.y],
      end: [end.x, end.y],
      style: s,
      keyframes: [],
    }
    return obj
  }
  const minX = Math.min(start.x, end.x)
  const minY = Math.min(start.y, end.y)
  const w = Math.abs(end.x - start.x)
  const h = Math.abs(end.y - start.y)
  // Floor so a near-zero click-drag still yields a usable, selectable shape.
  const ww = Math.max(w, 4)
  const hh = Math.max(h, 4)
  if (tool === 'rect') {
    const obj: RectObject = {
      id,
      type: 'rect',
      position: [minX, minY],
      width: ww,
      height: hh,
      style: s,
      fill: null,
      keyframes: [],
    }
    return obj
  }
  if (tool === 'ellipse') {
    const obj: EllipseObject = {
      id,
      type: 'ellipse',
      center: [minX + ww / 2, minY + hh / 2],
      radiusX: ww / 2,
      radiusY: hh / 2,
      style: s,
      fill: null,
      keyframes: [],
    }
    return obj
  }
  // triangle: apex-top isosceles inscribed in the bounding box.
  const obj: TriangleObject = {
    id,
    type: 'triangle',
    points: [
      [minX + ww / 2, minY],
      [minX + ww, minY + hh],
      [minX, minY + hh],
    ],
    style: s,
    fill: null,
    keyframes: [],
  }
  return obj
}

/** Live SVG preview of the shape being dragged (authored geometry, no keyframes). */
function DraftShapePreview({
  draft,
  style,
}: {
  draft: { tool: DragTool; start: { x: number; y: number }; end: { x: number; y: number } }
  style: StrokeStyle
}) {
  const obj = buildShape(draft.tool, draft.start, draft.end, style)
  if (!obj) return null
  return (
    <SceneObjectView obj={obj} time={0} selected={false} live={null} zoom={1} />
  )
}

/**
 * Inline HTML editor for a text/equation object. Positioned over the object via
 * `worldToScreen`, it edits the store's content live and commits (closes the
 * editor) on blur or Enter; Escape removes an empty object. Mounted as a sibling
 * of the SVG so the browser's native caret/selection/IME work normally.
 */
function InlineTextEditor({
  obj,
  viewport,
}: {
  obj: TextObject | EquationObject
  viewport: { offsetX: number; offsetY: number; zoom: number }
}) {
  const setObjectText = useSceneStore((s) => s.setObjectText)
  const setEditing = useSceneStore((s) => s.setEditing)
  const removeObject = useSceneStore((s) => s.removeObject)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const value = obj.type === 'text' ? obj.text : obj.latex
  const screen = worldToScreen(obj.position[0], obj.position[1], viewport)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commit = useCallback(() => {
    // Drop an object the user never typed into so stray clicks don't litter.
    const cur = useSceneStore.getState().objects.find((o) => o.id === obj.id)
    const text =
      cur && (cur.type === 'text' ? cur.text : cur.type === 'equation' ? cur.latex : '')
    if (!text || !text.trim()) {
      removeObject(obj.id)
    } else {
      setEditing(null)
    }
  }, [obj.id, removeObject, setEditing])

  return (
    <input
      ref={inputRef}
      className="inline-text-editor"
      value={value}
      placeholder={obj.type === 'equation' ? 'LaTeX, e.g. E = mc^2' : 'Type text…'}
      onChange={(e) => setObjectText(obj.id, e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          removeObject(obj.id)
        }
        e.stopPropagation()
      }}
      style={{
        position: 'absolute',
        left: `${screen.x}px`,
        top: `${screen.y}px`,
        transformOrigin: 'top left',
        transform: `scale(${viewport.zoom})`,
        fontSize: `${obj.fontSize}px`,
        color: obj.color,
        lineHeight: 1.2,
        zIndex: 20,
      }}
    />
  )
}

/**
 * One drawn stroke, rendered at its interpolated state for `time`. The authored
 * path is built once; the per-time transform (translate + rotate/scale about the
 * stroke centroid) is applied via an SVG `transform`. A live drag delta is added
 * on top.
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
