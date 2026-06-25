/**
 * serializeScene — pure function that builds the Scene wire object (T2 contract)
 * from the live scene-store state.
 *
 * The store already keeps `objects` in the exact wire shape, so this is mostly a
 * matter of assembling the surrounding `schemaVersion` / `timeline` / `camera`
 * envelope. Keeping it pure (state in → Scene out, no store access, no I/O) makes
 * it trivially testable and lets the Convert flow (PreviewPanel) call it with a
 * plain `useSceneStore.getState()` snapshot.
 *
 * The output validates against `backend/schema.py` (camelCase keys like
 * `schemaVersion`, `durationSeconds`) and matches
 * `agents/fixtures/example-scene.json`.
 */

import { SCHEMA_VERSION } from '../types/scene'
import type { Scene, SceneObject, CameraKeyframe } from '../types/scene'

/**
 * The subset of the scene store this serializer reads. Declared structurally
 * (rather than importing `SceneState`) so the function stays decoupled from the
 * store's action surface and is easy to call with a hand-built fixture in tests.
 */
export interface SerializableState {
  objects: SceneObject[]
  durationSeconds: number
  fps: number
  cameraWidth: number
  cameraHeight: number
  cameraKeyframes: CameraKeyframe[]
  /** Live camera base, used to synthesize a keyframe when none were authored. */
  cameraCenter: [number, number]
  cameraZoom: number
}

/**
 * Build the Scene wire object from a store snapshot.
 *
 * Camera keyframes: if the user authored none, we emit a single keyframe at
 * `t=0` from the live camera base so the backend always receives a well-defined
 * camera frame (the agent drives `self.camera.frame` from `camera.keyframes`).
 * Authored keyframes are passed through as-is (already sorted by the store).
 */
export function serializeScene(state: SerializableState): Scene {
  const keyframes: CameraKeyframe[] =
    state.cameraKeyframes.length > 0
      ? state.cameraKeyframes.map((k) => ({
          t: k.t,
          center: [k.center[0], k.center[1]],
          zoom: k.zoom,
        }))
      : [
          {
            t: 0,
            center: [state.cameraCenter[0], state.cameraCenter[1]],
            zoom: state.cameraZoom,
          },
        ]

  return {
    schemaVersion: SCHEMA_VERSION,
    timeline: {
      durationSeconds: state.durationSeconds,
      fps: state.fps,
    },
    camera: {
      width: state.cameraWidth,
      height: state.cameraHeight,
      keyframes,
    },
    objects: state.objects,
  }
}
