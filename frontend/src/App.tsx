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
 */

import { CanvasStage } from './canvas/CanvasStage'
import { ToolPalette } from './canvas/ToolPalette'
import './App.css'

function App() {
  return (
    <div className="app-shell">
      <CanvasStage />
      <ToolPalette />

      {/* EXTENSION POINT (T4 timeline): mount the bottom timeline bar here as
          an overlay so it sits above the canvas at the bottom edge. */}
    </div>
  )
}

export default App
