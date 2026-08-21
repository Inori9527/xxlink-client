import type { UnlistenFn } from './tauri-event'

export type Theme = 'light' | 'dark' | 'none'

export interface PreviewWindow {
  readonly label: string
  close: () => Promise<void>
  minimize: () => Promise<void>
  maximize: () => Promise<void>
  unmaximize: () => Promise<void>
  isMaximized: () => Promise<boolean>
  isFullscreen: () => Promise<boolean>
  setFullscreen: (fullscreen: boolean) => Promise<void>
  isDecorated: () => Promise<boolean>
  setDecorations: (decorated: boolean) => Promise<void>
  setMinimizable: (minimizable: boolean) => Promise<void>
  isVisible: () => Promise<boolean>
  setFocus: () => Promise<void>
  show: () => Promise<void>
  hide: () => Promise<void>
  listen: <T>(
    eventName: string,
    handler: (event: T) => void,
  ) => Promise<UnlistenFn>
  onResized: (handler: (event: unknown) => void) => Promise<UnlistenFn>
}

let maximized = false
let fullscreen = false
let decorated = true

const currentWindow: PreviewWindow = {
  label: 'main',
  close: async () => undefined,
  minimize: async () => undefined,
  maximize: async () => {
    maximized = true
  },
  unmaximize: async () => {
    maximized = false
  },
  isMaximized: async () => maximized,
  isFullscreen: async () => fullscreen,
  setFullscreen: async (value) => {
    fullscreen = value
  },
  isDecorated: async () => decorated,
  setDecorations: async (value) => {
    decorated = value
  },
  setMinimizable: async () => undefined,
  isVisible: async () => true,
  setFocus: async () => undefined,
  show: async () => undefined,
  hide: async () => undefined,
  listen:
    async <T>(
      _eventName: string,
      _handler: (event: T) => void,
    ): Promise<UnlistenFn> =>
    () =>
      undefined,
  onResized: async (_handler) => () => undefined,
}

export const getCurrentWindow = (): PreviewWindow => currentWindow
