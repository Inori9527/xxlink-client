export const AUTH_REFRESH_TRANSPORT_FORBIDDEN_CODE =
  'AUTH_REFRESH_TRANSPORT_FORBIDDEN'

type RefreshTransportErrorLike = {
  status?: number
  code?: string
}

export function createRefreshRequestInit(refreshToken: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    credentials: 'omit',
  }
}

export async function fetchRefreshWithBodyToken(
  url: string,
  refreshToken: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = globalThis.setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    return await globalThis.fetch(url, {
      ...createRefreshRequestInit(refreshToken),
      cache: 'no-store',
      signal: controller.signal,
    })
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
}

export function isRefreshTransportSessionError(
  error: RefreshTransportErrorLike,
): boolean {
  return error.status === 403 && error.code === 'CSRF_ORIGIN_FORBIDDEN'
}
