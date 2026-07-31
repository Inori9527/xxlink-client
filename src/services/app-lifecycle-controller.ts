import { invoke } from '@tauri-apps/api/core'

type UiReadyStage = 'Loading' | 'DomReady' | 'ResourcesLoaded'

export const appLifecycleController = {
  updateUiStage(stage: UiReadyStage) {
    return invoke<void>('update_ui_stage', { stage })
  },

  notifyUiReady() {
    return invoke<void>('notify_ui_ready')
  },
}
