/**
 * PreviewPanel (T7) — the right half of the split screen: the Convert action and
 * the rendered-video player.
 *
 * The Convert flow is a two-call pipeline against the backend (see
 * `docs/preview-flow.md`):
 *
 *   1. serialize the live store into the Scene wire shape (`serializeScene`)
 *   2. POST it to `/api/generate`  → `{ code, notes }`         (AI: scene → Manim)
 *   3. POST `{ code }` to `/api/render` → `{ status, videoUrl, logs, ... }`
 *   4. play `videoUrl` in a <video> on this panel
 *
 * The canvas stays fully editable throughout (this panel is a sibling, not a
 * modal), so the iterate loop is: edit canvas → Convert again → updated video.
 *
 * Manim renders can take many seconds; the flow is async and only this panel
 * shows a loading state — the UI never freezes.
 */

import { useCallback, useState } from 'react'
import { useSceneStore } from '../store/sceneStore'
import { serializeScene } from './serializeScene'

/** Backend response shapes (mirror backend/schema.py). */
interface GenerateResponse {
  code: string
  notes: string
}
interface RenderResponse {
  status: 'success' | 'error'
  videoUrl: string | null
  logs: string
  sceneName: string
}

/** Where the Convert flow currently is. Drives the panel's render. */
type Phase =
  | { kind: 'empty' }
  | { kind: 'generating' }
  | { kind: 'rendering'; notes: string }
  | { kind: 'success'; videoUrl: string; notes: string; sceneName: string }
  | { kind: 'error'; message: string; logs?: string }

/** Throw a useful Error if a fetch was not ok, including the response body. */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = await res.text()
    } catch {
      /* ignore body read failure */
    }
    throw new Error(`${url} → ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
  }
  return (await res.json()) as T
}

export function PreviewPanel() {
  const [phase, setPhase] = useState<Phase>({ kind: 'empty' })
  // True from the moment Convert is clicked until the pipeline settles. Used to
  // disable the button; the canvas itself is never disabled.
  const busy = phase.kind === 'generating' || phase.kind === 'rendering'

  const handleConvert = useCallback(async () => {
    // Snapshot the store imperatively (no React subscription needed here) and
    // serialize to the wire shape.
    const scene = serializeScene(useSceneStore.getState())

    if (scene.objects.length === 0) {
      setPhase({
        kind: 'error',
        message: 'Nothing to convert yet — draw a stroke on the canvas first.',
      })
      return
    }

    try {
      setPhase({ kind: 'generating' })
      const gen = await postJson<GenerateResponse>('/api/generate', scene)

      setPhase({ kind: 'rendering', notes: gen.notes })
      const render = await postJson<RenderResponse>('/api/render', { code: gen.code })

      if (render.status !== 'success' || !render.videoUrl) {
        setPhase({
          kind: 'error',
          message: 'Render failed. See the Manim logs below to fix the scene and try again.',
          logs: render.logs,
        })
        return
      }

      // Cache-bust so a re-convert that returns the same path still reloads.
      const videoUrl = `${render.videoUrl}${render.videoUrl.includes('?') ? '&' : '?'}t=${Date.now()}`
      setPhase({
        kind: 'success',
        videoUrl,
        notes: gen.notes,
        sceneName: render.sceneName,
      })
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Unexpected error during convert.',
      })
    }
  }, [])

  return (
    <section className="preview-panel" aria-label="Animation preview">
      <header className="preview-header">
        <h2 className="preview-title">Animation</h2>
        <button
          type="button"
          className="preview-convert"
          onClick={handleConvert}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? 'Converting…' : 'Convert to Animation'}
        </button>
      </header>

      <div className="preview-body">
        {phase.kind === 'empty' && (
          <div className="preview-state preview-state--empty">
            <p className="preview-state-title">No animation yet</p>
            <p className="preview-state-hint">
              Draw on the canvas, set keyframes and a camera move, then click{' '}
              <strong>Convert to Animation</strong>. The rendered video plays here.
            </p>
          </div>
        )}

        {busy && (
          <div className="preview-state preview-state--loading">
            <div className="preview-spinner" aria-hidden="true" />
            <p className="preview-state-title">
              {phase.kind === 'generating'
                ? 'Generating Manim code…'
                : 'Rendering video…'}
            </p>
            <p className="preview-state-hint">
              {phase.kind === 'generating'
                ? 'The AI agent is turning your scene into Manim.'
                : 'Manim is rendering — this can take a while. The canvas stays editable.'}
            </p>
          </div>
        )}

        {phase.kind === 'success' && (
          <div className="preview-result">
            <video
              key={phase.videoUrl}
              className="preview-video"
              src={phase.videoUrl}
              controls
              autoPlay
              loop
              playsInline
            />
            {phase.notes && (
              <details className="preview-notes">
                <summary>Agent notes</summary>
                <p>{phase.notes}</p>
              </details>
            )}
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="preview-state preview-state--error" role="alert">
            <p className="preview-state-title">Convert failed</p>
            <p className="preview-state-hint">{phase.message}</p>
            {phase.logs && (
              <details className="preview-logs" open>
                <summary>Render logs</summary>
                <pre className="preview-logs-pre">{phase.logs}</pre>
              </details>
            )}
            <p className="preview-state-hint">
              Edit the canvas to correct it, then click{' '}
              <strong>Convert to Animation</strong> again.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
