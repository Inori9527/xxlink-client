import type { UnlistenFn } from './tauri-event'
import type { Theme } from './tauri-window'

export interface WebviewWindow {
  readonly label: string
  setTheme: (theme: Theme) => Promise<void>
  show: () => Promise<void>
  hide: () => Promise<void>
  setFocus: () => Promise<void>
  isVisible: () => Promise<boolean>
  listen: <T>(
    eventName: string,
    handler: (event: T) => void,
  ) => Promise<UnlistenFn>
}

const currentWebviewWindow: WebviewWindow = {
  label: 'main',
  setTheme: async () => undefined,
  show: async () => undefined,
  hide: async () => undefined,
  setFocus: async () => undefined,
  isVisible: async () => true,
  listen:
    async <T>(
      _eventName: string,
      _handler: (event: T) => void,
    ): Promise<UnlistenFn> =>
    () =>
      undefined,
}

export const getCurrentWebviewWindow = (): WebviewWindow => currentWebviewWindow
