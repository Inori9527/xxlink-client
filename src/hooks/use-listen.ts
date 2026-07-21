import { event } from '@tauri-apps/api'
import { listen, UnlistenFn, EventCallback } from '@tauri-apps/api/event'
import { useCallback, useRef } from 'react'

import { reportSafeClientFailure } from '@/services/safe-client-error'

export const useListen = () => {
  const unlistenFnsRef = useRef<UnlistenFn[]>([])

  const addListener = useCallback(
    async <T>(eventName: string, handler: EventCallback<T>) => {
      const unlisten = await listen(eventName, handler)
      unlistenFnsRef.current.push(unlisten)
      return unlisten
    },
    [],
  )

  const removeAllListeners = useCallback(() => {
    unlistenFnsRef.current.forEach((unlisten) => {
      try {
        unlisten()
      } catch (error) {
        reportSafeClientFailure('listener-cleanup', error)
      }
    })

    unlistenFnsRef.current.length = 0
  }, [])

  const setupCloseListener = useCallback(async () => {
    await event.once('tauri://close-requested', async () => {
      removeAllListeners()
    })
  }, [removeAllListeners])

  return {
    addListener,
    removeAllListeners,
    setupCloseListener,
  }
}
