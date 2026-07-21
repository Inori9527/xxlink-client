import { reportSafeClientFailure } from '@/services/safe-client-error'

const OVERLAY_ID = 'initial-loading-overlay'
const REMOVE_DELAY = 300

let overlayRemoved = false

type HideOverlayOptions = {
  schedule?: (handler: () => void, delay: number) => number
  assumeMissingAsRemoved?: boolean
}

type HideOverlayResult = {
  removed: boolean
  removalTimer?: number
}

export const hideInitialOverlay = (
  options: HideOverlayOptions = {},
): HideOverlayResult => {
  if (overlayRemoved) {
    return { removed: true }
  }

  const overlay = document.getElementById(OVERLAY_ID)
  if (!overlay) {
    if (options.assumeMissingAsRemoved) {
      overlayRemoved = true
      return { removed: true }
    }
    return { removed: false }
  }

  overlayRemoved = true
  overlay.dataset.hidden = 'true'

  const schedule = options.schedule ?? window.setTimeout
  const removalTimer = schedule(() => {
    try {
      overlay.remove()
    } catch (error) {
      reportSafeClientFailure('loading-overlay-remove', error)
    }
  }, REMOVE_DELAY)

  return { removed: true, removalTimer }
}
