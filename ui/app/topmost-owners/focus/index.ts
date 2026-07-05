import type { FocusDefinition, FocusKey } from "./types"
import { DRIFT_FOCUS } from "./drift-focus"
import { PODS_FOCUS } from "./pods-focus"

export const FOCUSES: Record<FocusKey, FocusDefinition> = {
  drift: DRIFT_FOCUS,
  pods: PODS_FOCUS,
}

export const DEFAULT_FOCUS: FocusKey = "drift"

export const FOCUS_STORAGE_KEY = "topmost-owners-focus"

export function resolveFocusKey(param: string | null, stored: string | null): FocusKey {
  if (param && param in FOCUSES) return param as FocusKey
  if (stored && stored in FOCUSES) return stored as FocusKey
  return DEFAULT_FOCUS
}
