/**
 * Pure keyframe interpolation for the timeline (T4).
 *
 * The animation model is keyframe-based and matches the scene schema exactly
 * (`frontend/src/types/scene.ts`): each object carries `ObjectKeyframe[]`, where
 * a keyframe is `{ t, props: { position?, scale?, rotation?, opacity? } }`. The
 * `props` are deltas/multipliers applied on top of the object's AUTHORED
 * geometry and style:
 *
 *  - `position` — `[dx, dy]` translation in canvas px from the authored points.
 *  - `scale`    — uniform multiplier (1 = original size).
 *  - `rotation` — degrees, clockwise in the y-DOWN canvas.
 *  - `opacity`  — 0..1 multiplier on the style's base opacity.
 *
 * Interpolation is **linear** between successive keyframes (v1, per
 * `docs/scene-schema.md`). Before the first keyframe the value holds at the
 * first; after the last it holds at the last (clamp/hold at the ends).
 *
 * These functions are intentionally pure (no React, no store) so they are
 * trivially unit-testable and reused by both the canvas preview and any future
 * serialization/export path.
 */

import type { ObjectKeyframe, ObjectProps } from '../types/scene'

/**
 * Fully-resolved transform for an object at a given time. This is the "identity"
 * resolved state (no keyframes) by default, which renders the object exactly as
 * authored.
 */
export interface ResolvedTransform {
  /** Translation from authored geometry, canvas px. */
  position: [number, number]
  /** Uniform scale multiplier. */
  scale: number
  /** Rotation in degrees, clockwise (y-DOWN). */
  rotation: number
  /** Opacity multiplier (0..1) on the style opacity. */
  opacity: number
}

/** The neutral transform: object rendered exactly as authored. */
export const IDENTITY_TRANSFORM: ResolvedTransform = {
  position: [0, 0],
  scale: 1,
  rotation: 0,
  opacity: 1,
}

/** Linear interpolation between two scalars. */
function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f
}

/**
 * Resolve a single prop value at time `t` from a sorted keyframe list, given an
 * accessor that reads that prop from a keyframe (returning `undefined` when the
 * keyframe does not declare it) and an identity fallback used when no keyframe
 * declares the prop at all.
 *
 * Keyframes that do not declare the prop are skipped, so e.g. an `opacity`-only
 * keyframe does not disturb interpolation of `position`.
 */
function resolveScalar(
  keyframes: ObjectKeyframe[],
  t: number,
  read: (props: ObjectProps) => number | undefined,
  identity: number,
): number {
  // Collect only the keyframes that declare this prop, with their declared
  // value. They are already sorted by `t` ascending (store guarantees this).
  let prevT = -Infinity
  let prevV = identity
  let havePrev = false
  for (const kf of keyframes) {
    const v = read(kf.props)
    if (v === undefined) continue
    if (kf.t <= t) {
      prevT = kf.t
      prevV = v
      havePrev = true
      continue
    }
    // First declaring keyframe strictly after `t`.
    if (!havePrev) {
      // Before the first declaring keyframe: hold at it.
      return v
    }
    if (prevT === kf.t) return v
    const f = (t - prevT) / (kf.t - prevT)
    return lerp(prevV, v, f)
  }
  // `t` is at/after the last declaring keyframe (or none declared it): hold.
  return havePrev ? prevV : identity
}

/**
 * Resolve the full transform of an object's keyframes at time `t`.
 *
 * Objects with no keyframes resolve to {@link IDENTITY_TRANSFORM} (rendered at
 * their authored position). Each animated prop is interpolated independently so
 * a keyframe may declare only the props it changes.
 */
export function interpolateKeyframes(
  keyframes: ObjectKeyframe[],
  t: number,
): ResolvedTransform {
  if (!keyframes || keyframes.length === 0) return IDENTITY_TRANSFORM

  const px = resolveScalar(keyframes, t, (p) => p.position?.[0], 0)
  const py = resolveScalar(keyframes, t, (p) => p.position?.[1], 0)
  const scale = resolveScalar(keyframes, t, (p) => p.scale, 1)
  const rotation = resolveScalar(keyframes, t, (p) => p.rotation, 0)
  const opacity = resolveScalar(keyframes, t, (p) => p.opacity, 1)

  return { position: [px, py], scale, rotation, opacity }
}

/**
 * Insert or update a keyframe at time `t`, merging `props` into any existing
 * keyframe at (approximately) the same time and keeping the list sorted by `t`.
 * Returns a NEW array (pure) so it can drop straight into immutable store
 * updates. This is the shared capture primitive — T5's camera keyframes reuse
 * the same upsert pattern on their own keyframe array.
 */
export function upsertKeyframe(
  keyframes: ObjectKeyframe[],
  t: number,
  props: ObjectProps,
  /** Times within this many seconds are treated as the same keyframe. */
  epsilon = 1e-4,
): ObjectKeyframe[] {
  const next = keyframes.map((k) => ({ t: k.t, props: { ...k.props } }))
  const existing = next.find((k) => Math.abs(k.t - t) <= epsilon)
  if (existing) {
    existing.props = { ...existing.props, ...props }
  } else {
    next.push({ t, props: { ...props } })
    next.sort((a, b) => a.t - b.t)
  }
  return next
}
