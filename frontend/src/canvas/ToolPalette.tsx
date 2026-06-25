/**
 * Floating tool palette (Excalidraw-like chrome). Holds the tool selection and
 * a couple of canvas actions. Kept intentionally small for T1 — shape/text/
 * eraser tools are out of scope and slot in here later.
 */

import { useSceneStore, type Tool } from '../store/sceneStore'

interface ToolDef {
  id: Tool
  label: string
  /** Single-character glyph used as the button icon. */
  glyph: string
  hint: string
}

const TOOLS: ToolDef[] = [
  { id: 'select', label: 'Select / Pan', glyph: '✋', hint: 'Select / pan the canvas (V)' },
  { id: 'draw', label: 'Draw', glyph: '✎', hint: 'Freehand draw (D)' },
  { id: 'text', label: 'Text', glyph: 'T', hint: 'Text box — click to place (T)' },
  { id: 'line', label: 'Line', glyph: '╱', hint: 'Line — drag start → end (L)' },
  { id: 'arrow', label: 'Arrow', glyph: '→', hint: 'Arrow — drag tail → head (A)' },
  { id: 'rect', label: 'Rectangle', glyph: '▭', hint: 'Rectangle — drag a box (R)' },
  { id: 'ellipse', label: 'Ellipse', glyph: '◯', hint: 'Ellipse — drag a box (O)' },
  { id: 'triangle', label: 'Triangle', glyph: '△', hint: 'Triangle — drag a box' },
  { id: 'equation', label: 'Equation', glyph: '∑', hint: 'LaTeX equation — click to place (E)' },
]

export function ToolPalette() {
  const tool = useSceneStore((s) => s.tool)
  const setTool = useSceneStore((s) => s.setTool)
  const clear = useSceneStore((s) => s.clear)
  const zoom = useSceneStore((s) => s.viewport.zoom)

  return (
    <div className="tool-palette" role="toolbar" aria-label="Canvas tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`tool-btn${tool === t.id ? ' is-active' : ''}`}
          title={t.hint}
          aria-pressed={tool === t.id}
          aria-label={t.label}
          onClick={() => setTool(t.id)}
        >
          <span className="tool-glyph" aria-hidden>
            {t.glyph}
          </span>
        </button>
      ))}
      <div className="tool-sep" />
      <button
        className="tool-btn tool-btn--text"
        title="Clear canvas"
        aria-label="Clear canvas"
        onClick={clear}
      >
        Clear
      </button>
      <span className="tool-zoom" title="Current zoom">
        {Math.round(zoom * 100)}%
      </span>
    </div>
  )
}
