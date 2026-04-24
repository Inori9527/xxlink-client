import { useCallback, useEffect, useState } from 'react'

export type ConnectMode = 'system' | 'both'

export const CONNECT_MODE_STORAGE_KEY = 'xxlink:connect-mode'
const CONNECT_MODE_EVENT = 'xxlink:connect-mode-changed'
const DEFAULT_CONNECT_MODE: ConnectMode = 'both'

const normalizeConnectMode = (value: string | null | undefined): ConnectMode => {
  if (value === 'system' || value === 'both') {
    return value
  }

  // Legacy 'tun' mode was removed. Keep old installs on the recommended mode.
  if (value === 'tun') {
    return 'both'
  }

  return DEFAULT_CONNECT_MODE
}

export const loadConnectMode = (): ConnectMode => {
  try {
    return normalizeConnectMode(localStorage.getItem(CONNECT_MODE_STORAGE_KEY))
  } catch {
    return DEFAULT_CONNECT_MODE
  }
}

export const persistConnectMode = (mode: ConnectMode) => {
  try {
    localStorage.setItem(CONNECT_MODE_STORAGE_KEY, mode)
  } catch {
    /* ignore */
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<ConnectMode>(CONNECT_MODE_EVENT, {
        detail: mode,
      }),
    )
  }
}

export const getConnectModePayload = (
  mode: ConnectMode,
  enabled: boolean,
): Partial<IVergeConfig> => {
  if (mode === 'system') {
    return {
      enable_tun_mode: false,
      enable_system_proxy: enabled,
    }
  }

  return {
    enable_tun_mode: enabled,
    enable_system_proxy: enabled,
  }
}

export const useConnectMode = () => {
  const [mode, setModeState] = useState<ConnectMode>(() => loadConnectMode())

  useEffect(() => {
    if (typeof window === 'undefined') return

    const syncMode = () => setModeState(loadConnectMode())
    const handleSameTabChange = (event: Event) => {
      const detail = (event as CustomEvent<ConnectMode>).detail
      setModeState(normalizeConnectMode(detail))
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== CONNECT_MODE_STORAGE_KEY) return
      syncMode()
    }

    window.addEventListener(CONNECT_MODE_EVENT, handleSameTabChange)
    window.addEventListener('storage', handleStorage)

    return () => {
      window.removeEventListener(CONNECT_MODE_EVENT, handleSameTabChange)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  const setMode = useCallback((nextMode: ConnectMode) => {
    persistConnectMode(nextMode)
    setModeState(nextMode)
  }, [])

  return { mode, setMode }
}
