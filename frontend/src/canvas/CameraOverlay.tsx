/**
 * Camera viewport indicator (T5).
 *
 * Renders the "camera frame" as an SVG group INSIDE the canvas world transform
 * (mounted at the EXTENSION POINT in `CanvasStage`), so it pans/zooms with the
 * scene. The frame is **aspect-locked** to the output resolution
 * (`cameraWidth` / `cameraHeight`, default 1920×1080 = 16:9): its world-space
 * size is `width / zoom` × `height / zoom`, centered on `center` (canvas px,
 * y-DOWN). `zoom > 1` ⇒ a smaller frame ⇒ zoomed in, matching the schema and
 * `docs/scene-schema.md`.
 *
 * Interaction (reusing the T4 capture pattern, mirrored on camera keyframes):
 *  - Drag the frame body  → moves `center`.
 *  - Drag a corner handle → resizes the frame, anchored at the opposite corner,
 *    deriving `zoom` from the new width (aspect stays locked by construction).
 *  - On pointer-up, the live edit is committed as a camera keyframe at
 *    `currentTime` via `endCameraEdit` (mirror of object `endObjectDrag`).
 *
 * During scrub/play the frame reads the interpolated camera for `time`, so it
 * animates linearly between camera keyframes just like objects.
 */

import { useCallback, useRef } from 'react'
import { useSceneStore } from '../store/sceneStore'

/** Which corner is being dragged for a resize. */
type Corner = 'nw' | 'ne' | 'se' | 'sw'

/** Visual handle size in screen px (kept constant via 1/zoom world scaling). */
const HANDLE_PX = 10

export function CameraOverlay({ time }: { time: number }) {
  const cameraWidth = useSceneStore((s) => s.cameraWidth)
  const cameraHeight = useSceneStore((s) => s.cameraHeight)
  const zoom = useSceneStore((s) => s.viewport.zoom)
  // Subscribe to the pieces that drive the resolved frame so it re-renders on
  // scrub/play and on commit. `resolveCameraAt` reads them via getState.
  useSceneStore((s) => s.cameraKeyframes)
  useSceneStore((s) => s.cameraCenter)
  useSceneStore((s) => s.cameraZoom)
  useSceneStore((s) => s.liveCamera)

  const beginCameraEdit = useSceneStore((s) => s.beginCameraEdit)
  const dragCamera = useSceneStore((s) => s.dragCamera)
  const endCameraEdit = useSceneStore((s) => s.endCameraEdit)

  // Resolved frame for this time (live edit wins inside resolveCameraAt).
  const resolved = useSceneStore.getState().resolveCameraAt(time)
  const [cx, cy] = resolved.center
  const camZoom = resolved.zoom

  // World-space frame size: locked to the output aspect (width/height).
  const frameW = cameraWidth / camZoom
  const frameH = cameraHeight / camZoom
  const x = cx - frameW / 2
  const y = cy - frameH / 2

  // Gesture bookkeeping (no re-render on move).
  const drag = useRef<{
    mode: 'move' | Corner
    startWorld: { x: number; y: number }
    startCenter: [number, number]
    startZoom: number
    /** For resize: the fixed (anchor) corner in world space. */
    anchor: { x: number; y: number }
  } | null>(null)

  /** Pointer client coords → world coords using the live viewport. */
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const { viewport } = useSceneStore.getState()
    // The overlay's owning <svg> is the canvas-stage; find it from the event
    // target chain is overkill — use the shared viewport math directly. We
    // need the svg's client rect to subtract its offset.
    const svg = document.querySelector('.canvas-stage') as SVGSVGElement | null
    const rect = svg?.getBoundingClientRect()
    const sx = clientX - (rect?.left ?? 0)
    const sy = clientY - (rect?.top ?? 0)
    return {
      x: (sx - viewport.offsetX) / viewport.zoom,
      y: (sy - viewport.offsetY) / viewport.zoom,
    }
  }, [])

  const onBodyDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation()
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      const w = toWorld(e.clientX, e.clientY)
      beginCameraEdit()
      const r = useSceneStore.getState().resolveCameraAt(useSceneStore.getState().currentTime)
      drag.current = {
        mode: 'move',
        startWorld: w,
        startCenter: [r.center[0], r.center[1]],
        startZoom: r.zoom,
        anchor: { x: 0, y: 0 },
      }
    },
    [beginCameraEdit, toWorld],
  )

  const onHandleDown = useCallback(
    (corner: Corner) => (e: React.PointerEvent) => {
      e.stopPropagation()
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      const w = toWorld(e.clientX, e.clientY)
      beginCameraEdit()
      const r = useSceneStore.getState().resolveCameraAt(useSceneStore.getState().currentTime)
      const fw = cameraWidth / r.zoom
      const fh = cameraHeight / r.zoom
      const left = r.center[0] - fw / 2
      const right = r.center[0] + fw / 2
      const top = r.center[1] - fh / 2
      const bottom = r.center[1] + fh / 2
      // Anchor = the corner diagonally opposite the dragged one (stays fixed).
      const anchor =
        corner === 'nw'
          ? { x: right, y: bottom }
          : corner === 'ne'
            ? { x: left, y: bottom }
            : corner === 'se'
              ? { x: left, y: top }
              : { x: right, y: top }
      drag.current = {
        mode: corner,
        startWorld: w,
        startCenter: [r.center[0], r.center[1]],
        startZoom: r.zoom,
        anchor,
      }
    },
    [beginCameraEdit, toWorld, cameraWidth, cameraHeight],
  )

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      if (!d) return
      const w = toWorld(e.clientX, e.clientY)
      if (d.mode === 'move') {
        const dx = w.x - d.startWorld.x
        const dy = w.y - d.startWorld.y
        dragCamera({ center: [d.startCenter[0] + dx, d.startCenter[1] + dy] })
        return
      }
      // Resize: aspect is locked, so derive the new frame width from the
      // pointer's horizontal distance to the fixed anchor, then snap height to
      // the locked aspect. New center is the midpoint of anchor and the
      // aspect-corrected dragged corner.
      const aspect = cameraWidth / cameraHeight
      let newW = Math.abs(w.x - d.anchor.x)
      // Also consider vertical distance so dragging feels natural; take the
      // larger implied width so the frame encloses the cursor.
      const newWFromH = Math.abs(w.y - d.anchor.y) * aspect
      newW = Math.max(newW, newWFromH)
      const finalW = Math.max(8, newW) // floor so it never collapses
      const finalH = finalW / aspect
      // Signed direction from the anchor toward the dragged corner.
      const signX = w.x >= d.anchor.x ? 1 : -1
      const signY = w.y >= d.anchor.y ? 1 : -1
      const draggedX = d.anchor.x + signX * finalW
      const draggedY = d.anchor.y + signY * finalH
      const center: [number, number] = [
        (d.anchor.x + draggedX) / 2,
        (d.anchor.y + draggedY) / 2,
      ]
      // zoom = cameraWidth / frameWidth (frame world width = cameraWidth/zoom).
      const newZoom = cameraWidth / finalW
      dragCamera({ center, zoom: newZoom })
    },
    [dragCamera, toWorld, cameraWidth, cameraHeight],
  )

  const onUp = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return
      drag.current = null
      ;(e.target as Element).releasePointerCapture?.(e.pointerId)
      endCameraEdit()
    },
    [endCameraEdit],
  )

  // Constant on-screen sizes: divide by viewport zoom so border/handles keep
  // their pixel weight as the canvas zooms (matches vector-effect intent).
  const handleW = HANDLE_PX / zoom
  const strokeW = 2 / zoom

  const corners: { c: Corner; x: number; y: number; cursor: string }[] = [
    { c: 'nw', x, y, cursor: 'nwse-resize' },
    { c: 'ne', x: x + frameW, y, cursor: 'nesw-resize' },
    { c: 'se', x: x + frameW, y: y + frameH, cursor: 'nwse-resize' },
    { c: 'sw', x, y: y + frameH, cursor: 'nesw-resize' },
  ]

  return (
    <g
      className="camera-overlay"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {/* Frame border (the camera viewport). The body is draggable to move. */}
      <rect
        className="camera-frame"
        x={x}
        y={y}
        width={frameW}
        height={frameH}
        fill="transparent"
        stroke="var(--accent)"
        strokeWidth={strokeW}
        vectorEffect="non-scaling-stroke"
        style={{ cursor: 'move' }}
        onPointerDown={onBodyDown}
      />
      {/* Subtle inner border for contrast on busy backgrounds. */}
      <rect
        x={x}
        y={y}
        width={frameW}
        height={frameH}
        fill="none"
        stroke="var(--bg)"
        strokeWidth={strokeW * 0.5}
        strokeOpacity={0.5}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
      {/* Corner handles (aspect-locked resize). */}
      {corners.map((h) => (
        <rect
          key={h.c}
          className="camera-handle"
          x={h.x - handleW / 2}
          y={h.y - handleW / 2}
          width={handleW}
          height={handleW}
          fill="var(--bg)"
          stroke="var(--accent)"
          strokeWidth={strokeW}
          vectorEffect="non-scaling-stroke"
          style={{ cursor: h.cursor }}
          onPointerDown={onHandleDown(h.c)}
        />
      ))}
      {/* "CAMERA" tag at the top-left of the frame, scaled to stay readable. */}
      <text
        className="camera-label"
        x={x + 6 / zoom}
        y={y - 6 / zoom}
        fill="var(--accent)"
        fontSize={12 / zoom}
        style={{ userSelect: 'none' }}
        pointerEvents="none"
      >
        CAMERA
      </text>
    </g>
  )
}
