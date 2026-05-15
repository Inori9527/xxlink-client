import { fetch } from '@tauri-apps/plugin-http'

export const DEFAULT_API_TIMEOUT_MS = 10_000
export const DEFAULT_AUTH_TIMEOUT_MS = 8_000
export const DEFAULT_REFRESH_TIMEOUT_MS = 5_000

type FetchOptions = NonNullable<Parameters<typeof fetch>[1]>

export class RequestTimeoutError extends Error {
  readonly code = 'NETWORK_TIMEOUT'

  constructor(message = 'Request timed out') {
    super(message)
    this.name = 'RequestTimeoutError'
  }
}

export async function fetchWithTimeout(
  url: string,
  options: FetchOptions = {},
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const upstreamSignal = options.signal
  let upstreamAbortListener: (() => void) | null = null

  if (upstreamSignal) {
    upstreamAbortListener = () => controller.abort()
    if (upstreamSignal.aborted) {
      controller.abort()
    } else {
      upstreamSignal.addEventListener('abort', upstreamAbortListener, {
        once: true,
      })
    }
  }

  const timeoutId = window.setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      connectTimeout: options.connectTimeout ?? timeoutMs,
    })
  } catch (error) {
    if (controller.signal.aborted && !upstreamSignal?.aborted) {
      throw new RequestTimeoutError()
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
    if (upstreamSignal && upstreamAbortListener) {
      upstreamSignal.removeEventListener('abort', upstreamAbortListener)
    }
  }
}
