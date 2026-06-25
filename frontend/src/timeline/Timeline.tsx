/**
 * Bottom timeline bar (T4) — Excalidraw-like chrome fixed to the bottom of the
 * canvas. Owns:
 *
 *  - a draggable playhead/scrubber bound to the store's `currentTime` (seconds),
 *  - play / pause that advances `currentTime` from 0 → duration via rAF,
 *  - a time / duration readout,
 *  - per-object keyframe dots on the track for the selected object (or all
 *    objects when nothing is selected), so captured keyframes are visible.
 *
 * Scrubbing or playing re-renders every object at its interpolated state for
 * `currentTime` (the canvas reads the same `currentTime` from the store).
 *
 * The play loop lives here (not the store) so it is tied to the component
 * lifecycle and uses `requestAnimationFrame` wall-clock timing rather than
 * frame-count drift.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useSceneStore } from '../store/sceneStore'

/** Horizontal padding (px) inside the track where the playhead can travel. */
const TRACK_PAD = 8

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const whole = Math.floor(s)
  const cs = Math.round((s - whole) * 100)
  return `${whole}.${cs.toString().padStart(2, '0')}s`
}

export function Timeline() {
  const currentTime = useSceneStore((s) => s.currentTime)
  const durationSeconds = useSceneStore((s) => s.durationSeconds)
  const isPlaying = useSceneStore((s) => s.isPlaying)
  const objects = useSceneStore((s) => s.objects)
  const selectedId = useSceneStore((s) => s.selectedId)

  const setCurrentTime = useSceneStore((s) => s.setCurrentTime)
  const setPlaying = useSceneStore((s) => s.setPlaying)
  const togglePlaying = useSceneStore((s) => s.togglePlaying)
  const setDuration = useSceneStore((s) => s.setDuration)

  const trackRef = useRef<HTMLDivElement | null>(null)
  const scrubbing = useRef(false)

  // --- play loop: advance currentTime by real elapsed time, loop at the end ---
  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const { currentTime: t, durationSeconds: dur } = useSceneStore.getState()
      let next = t + dt
      if (next >= dur) {
        // Loop back to start so play is repeatable without manual reset.
        next = next % dur
      }
      setCurrentTime(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, setCurrentTime])

  // Map a clientX to a time, clamped to the track.
  const timeFromClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      const usable = Math.max(1, rect.width - TRACK_PAD * 2)
      const x = clientX - rect.left - TRACK_PAD
      const frac = Math.min(1, Math.max(0, x / usable))
      return frac * durationSeconds
    },
    [durationSeconds],
  )

  const onScrubDown = useCallback(
    (e: React.PointerEvent) => {
      scrubbing.current = true
      setPlaying(false)
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      setCurrentTime(timeFromClientX(e.clientX))
    },
    [setPlaying, setCurrentTime, timeFromClientX],
  )

  const onScrubMove = useCallback(
    (e: React.PointerEvent) => {
      if (!scrubbing.current) return
      setCurrentTime(timeFromClientX(e.clientX))
    },
    [setCurrentTime, timeFromClientX],
  )

  const onScrubUp = useCallback((e: React.PointerEvent) => {
    scrubbing.current = false
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
  }, [])

  const frac = durationSeconds > 0 ? currentTime / durationSeconds : 0
  const playheadPct = `${(frac * 100).toFixed(3)}%`

  // Keyframe dots: for the selected object, or union across all objects.
  const dotObjects = selectedId
    ? objects.filter((o) => o.id === selectedId)
    : objects
  const dots = dotObjects.flatMap((o) =>
    o.keyframes.map((k) => ({
      id: `${o.id}@${k.t}`,
      pct: durationSeconds > 0 ? (k.t / durationSeconds) * 100 : 0,
    })),
  )

  return (
    <div className="timeline" role="group" aria-label="Animation timeline">
      <button
        className="timeline-play"
        onClick={togglePlaying}
        aria-pressed={isPlaying}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        title={isPlaying ? 'Pause (preview)' : 'Play (preview)'}
      >
        {isPlaying ? '⏸' : '▶'}
      </button>

      <div
        className="timeline-track"
        ref={trackRef}
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={onScrubUp}
        onPointerCancel={onScrubUp}
        role="slider"
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={durationSeconds}
        aria-valuenow={Number(currentTime.toFixed(2))}
        aria-valuetext={`${formatTime(currentTime)} of ${formatTime(durationSeconds)}`}
        tabIndex={0}
      >
        <div className="timeline-track-line" />
        {dots.map((d) => (
          <div
            key={d.id}
            className="timeline-keyframe"
            style={{ left: `${d.pct}%` }}
            aria-hidden
          />
        ))}
        <div className="timeline-playhead" style={{ left: playheadPct }}>
          <div className="timeline-playhead-knob" />
        </div>
      </div>

      <span className="timeline-readout" title="Current time / duration">
        {formatTime(currentTime)} / {formatTime(durationSeconds)}
      </span>

      {/* Adjustable max duration (seconds). Re-clamps the playhead via the
          store's setDuration; keyframes past the new end stay but the playhead
          clamps in. */}
      <label className="timeline-duration" title="Timeline length (seconds)">
        <span className="timeline-duration-label">dur</span>
        <input
          className="timeline-duration-input"
          type="number"
          min={0.1}
          step={0.5}
          value={Number(durationSeconds.toFixed(2))}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            if (!Number.isNaN(v)) setDuration(v)
          }}
          aria-label="Timeline duration in seconds"
        />
        <span className="timeline-duration-unit">s</span>
      </label>
    </div>
  )
}
