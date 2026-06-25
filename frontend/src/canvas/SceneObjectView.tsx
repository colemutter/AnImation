/**
 * Renderer for every non-freehand `SceneObject` variant (F2): text, equation,
 * line, arrow, rect, ellipse, triangle.
 *
 * Each object is drawn at its AUTHORED geometry inside a wrapper `<g>` that
 * applies the interpolated keyframe transform (translate → rotate/scale about
 * the object's center) for `time`, plus any live, uncommitted drag delta. This
 * mirrors `StrokePath` for freehand strokes so scrubbing/playing only updates
 * the wrapper, never the geometry.
 */

import { useMemo } from 'react'
import katex from 'katex'
import type {
  SceneObject,
  TextObject,
  EquationObject,
  LineObject,
  ArrowObject,
  RectObject,
  EllipseObject,
  TriangleObject,
  StrokeStyle,
} from '../types/scene'
import { interpolateKeyframes } from '../timeline/interpolate'
import { objectBounds, objectCenter } from './objectGeometry'

/** Render an equation's LaTeX to an HTML string, falling back to raw source. */
function renderLatex(latex: string): { html: string; ok: boolean } {
  if (!latex.trim()) return { html: '', ok: true }
  try {
    return {
      html: katex.renderToString(latex, { throwOnError: true, displayMode: false }),
      ok: true,
    }
  } catch {
    return { html: latex, ok: false }
  }
}

export function SceneObjectView({
  obj,
  time,
  selected,
  live,
  zoom,
}: {
  obj: SceneObject
  time: number
  selected: boolean
  live: { dx: number; dy: number } | null
  /** Viewport zoom — for non-scaling stroke weights on the selection box. */
  zoom: number
}) {
  const resolved = interpolateKeyframes(obj.keyframes, time)
  const c = objectCenter(obj)
  const tx = resolved.position[0] + (live ? live.dx : 0)
  const ty = resolved.position[1] + (live ? live.dy : 0)
  const transform =
    `translate(${tx} ${ty}) ` +
    `translate(${c.x} ${c.y}) ` +
    `rotate(${resolved.rotation}) ` +
    `scale(${resolved.scale}) ` +
    `translate(${-c.x} ${-c.y})`

  const b = objectBounds(obj)

  return (
    <g transform={transform} opacity={resolved.opacity}>
      {renderBody(obj)}
      {selected && (
        <rect
          x={b.minX}
          y={b.minY}
          width={Math.max(1, b.maxX - b.minX)}
          height={Math.max(1, b.maxY - b.minY)}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2 / zoom}
          strokeDasharray={`${6 / zoom} ${4 / zoom}`}
          strokeOpacity={0.9}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      )}
    </g>
  )
}

/** Dispatch to the per-variant SVG body (authored geometry, no transform). */
function renderBody(obj: SceneObject) {
  switch (obj.type) {
    case 'text':
      return <TextBody obj={obj} />
    case 'equation':
      return <EquationBody obj={obj} />
    case 'line':
      return <LineBody obj={obj} />
    case 'arrow':
      return <ArrowBody obj={obj} />
    case 'rect':
      return <RectBody obj={obj} />
    case 'ellipse':
      return <EllipseBody obj={obj} />
    case 'triangle':
      return <TriangleBody obj={obj} />
    case 'freehand':
      return null // handled by StrokePath
  }
}

function TextBody({ obj }: { obj: TextObject }) {
  // y = top + fontSize so the text sits below the authored top-left anchor.
  return (
    <text
      x={obj.position[0]}
      y={obj.position[1] + obj.fontSize}
      fill={obj.color}
      fontSize={obj.fontSize}
      fontFamily="ui-sans-serif, system-ui, sans-serif"
      style={{ whiteSpace: 'pre', userSelect: 'none' }}
    >
      {obj.text}
    </text>
  )
}

function EquationBody({ obj }: { obj: EquationObject }) {
  const { html, ok } = useMemo(() => renderLatex(obj.latex), [obj.latex])
  const b = objectBounds(obj)
  const w = Math.max(40, b.maxX - b.minX)
  const h = Math.max(obj.fontSize * 1.4, b.maxY - b.minY)
  return (
    <foreignObject
      x={obj.position[0]}
      y={obj.position[1]}
      width={w}
      height={h}
      style={{ overflow: 'visible' }}
    >
      <div
        style={{
          color: obj.color,
          fontSize: ok ? obj.fontSize : obj.fontSize * 0.8,
          lineHeight: 1.2,
          fontFamily: ok ? undefined : 'ui-monospace, monospace',
          whiteSpace: 'nowrap',
          userSelect: 'none',
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </foreignObject>
  )
}

function strokeProps(style: StrokeStyle) {
  return {
    stroke: style.color,
    strokeWidth: style.width,
    strokeOpacity: style.opacity,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
}

function LineBody({ obj }: { obj: LineObject }) {
  return (
    <line
      x1={obj.start[0]}
      y1={obj.start[1]}
      x2={obj.end[0]}
      y2={obj.end[1]}
      fill="none"
      {...strokeProps(obj.style)}
    />
  )
}

function ArrowBody({ obj }: { obj: ArrowObject }) {
  const [x0, y0] = obj.start
  const [x1, y1] = obj.end
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  // Arrowhead size scales with stroke width but has a sensible floor.
  const head = Math.max(10, obj.style.width * 3)
  // Two barbs at +/- 30 deg from the reversed direction.
  const ang = Math.atan2(uy, ux)
  const a1 = ang + Math.PI - Math.PI / 6
  const a2 = ang + Math.PI + Math.PI / 6
  const h1x = x1 + Math.cos(a1) * head
  const h1y = y1 + Math.sin(a1) * head
  const h2x = x1 + Math.cos(a2) * head
  const h2y = y1 + Math.sin(a2) * head
  return (
    <g fill="none" {...strokeProps(obj.style)}>
      <line x1={x0} y1={y0} x2={x1} y2={y1} />
      <polyline points={`${h1x},${h1y} ${x1},${y1} ${h2x},${h2y}`} />
    </g>
  )
}

function RectBody({ obj }: { obj: RectObject }) {
  return (
    <rect
      x={obj.position[0]}
      y={obj.position[1]}
      width={Math.max(0, obj.width)}
      height={Math.max(0, obj.height)}
      fill={obj.fill ?? 'none'}
      {...strokeProps(obj.style)}
    />
  )
}

function EllipseBody({ obj }: { obj: EllipseObject }) {
  return (
    <ellipse
      cx={obj.center[0]}
      cy={obj.center[1]}
      rx={Math.max(0, obj.radiusX)}
      ry={Math.max(0, obj.radiusY)}
      fill={obj.fill ?? 'none'}
      {...strokeProps(obj.style)}
    />
  )
}

function TriangleBody({ obj }: { obj: TriangleObject }) {
  const pts = obj.points.map(([x, y]) => `${x},${y}`).join(' ')
  return (
    <polygon points={pts} fill={obj.fill ?? 'none'} {...strokeProps(obj.style)} />
  )
}
