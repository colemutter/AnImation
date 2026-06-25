/**
 * App shell for the canvas-to-Manim animator.
 *
 * T1 ships the canvas foundation: an infinite pannable/zoomable canvas with a
 * floating tool palette and a working freehand draw tool. Drawn objects live in
 * the zustand scene store (`useSceneStore`), already in the wire schema shape.
 *
 * EXTENSION POINTS for later tasks:
 *  - T4 timeline: a bottom timeline bar mounts as an overlay sibling of the
 *    canvas (see marker below).
 *  - T5 camera: the camera rectangle overlay lives inside the canvas world
 *    transform (see CanvasStage.tsx).
 *  - T7 layout/preview: this shell splits into canvas + video preview.
 *
 * T7 split screen: the shell is now a two-pane flex layout — the editor pane
 * (canvas + palette + timeline + camera overlay) on the left, the
 * <PreviewPanel/> (Convert button + rendered video) on the right. The canvas
 * pane is its own positioning context so the floating palette/timeline/camera
 * overlays stay scoped to the left half. The canvas stays fully editable while
 * a render is in flight, so the iterate loop (edit → Convert → new video) works.
 */

import { CanvasStage } from './canvas/CanvasStage'
import { ToolPalette } from './canvas/ToolPalette'
import { Timeline } from './timeline/Timeline'
import { PreviewPanel } from './preview/PreviewPanel'
import './App.css'

function App() {
  return (
    <div className="app-shell">
      {/* Left pane: the live editor. Its own positioning context so the
          floating palette/timeline/camera overlays anchor to this half. */}
      <div className="editor-pane">
        <CanvasStage />
        <ToolPalette />

        {/* EXTENSION POINT (T4 timeline): mounted as an overlay so it sits above
            the canvas at the bottom edge. */}
        <Timeline />
      </div>

      {/* Right pane: Convert action + video preview (the iterate loop). */}
      <PreviewPanel />
    </div>
  )
}

export default App
