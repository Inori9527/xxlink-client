import { getName, getVersion } from '@tauri-apps/api/app'
import { asyncRetry } from 'foxts/async-retry'
import { once } from 'foxts/once'

import { BASE_URL } from '@/services/config'
import { fetchWithTimeout } from '@/services/http'

export type AnnouncementLevel = 'info' | 'success' | 'warning' | 'error'

export interface Announcement {
  id: string
  title: string
  body: string
  level?: AnnouncementLevel | string
  publishedAt?: string | null
  actionLabel?: string | null
  actionUrl?: string | null
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function isAuthFatalError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 ||
      error.status === 403 ||
      error.code === 'ACCOUNT_DISABLED' ||
      error.code === 'ACCOUNT_BLOCKED' ||
      error.code === 'SESSION_REVOKED')
  )
}

const ANNOUNCEMENT_LATEST_PATH =
  (import.meta.env['VITE_ANNOUNCEMENT_LATEST_PATH'] as string | undefined) ??
  '/announcements/latest'
const ANNOUNCEMENT_LATEST_BROADCAST_PATH =
  (import.meta.env['VITE_ANNOUNCEMENT_LATEST_BROADCAST_PATH'] as
    | string
    | undefined) ?? '/announcements/latest?channel=CLIENT&type=BROADCAST'
const ANNOUNCEMENT_UPDATE_LIST_PATH =
  (import.meta.env['VITE_ANNOUNCEMENT_UPDATE_LIST_PATH'] as
    | string
    | undefined) ?? '/announcements?channel=CLIENT&type=UPDATE'

interface BackendResponse<T> {
  success: boolean
  data?: T
  error?: string | { message?: string; code?: string }
}

function getBackendErrorCode<T>(json: BackendResponse<T> | null | undefined) {
  const error = json?.error
  return typeof error === 'object' ? error?.code : undefined
}

async function publicRequest<T>(path: string): Promise<T> {
  const response = await fetchWithTimeout(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  })

  let json: BackendResponse<T>
  try {
    json = (await response.json()) as BackendResponse<T>
  } catch {
    throw new ApiError('Server returned an invalid response', response.status)
  }

  const code = getBackendErrorCode(json)
  if (!response.ok || !json.success) {
    throw new ApiError('Request failed', response.status, code)
  }
  if (!('data' in json)) {
    throw new ApiError(
      'Server response missing data',
      response.status,
      'MALFORMED_RESPONSE',
    )
  }
  return json.data as T
}

export const api = {
  announcements: {
    latest: () => publicRequest<Announcement | null>(ANNOUNCEMENT_LATEST_PATH),
    latestBroadcast: () =>
      publicRequest<Announcement | null>(ANNOUNCEMENT_LATEST_BROADCAST_PATH),
    listUpdates: (limit = 20) => {
      const separator = ANNOUNCEMENT_UPDATE_LIST_PATH.includes('?') ? '&' : '?'
      return publicRequest<Announcement[]>(
        `${ANNOUNCEMENT_UPDATE_LIST_PATH}${separator}limit=${encodeURIComponent(
          String(limit),
        )}`,
      )
    },
  },
}

const getUserAgentPromise = once(async () => {
  try {
    const [name, version] = await Promise.all([getName(), getVersion()])
    return `${name}/${version}`
  } catch {
    return 'xxlink-client'
  }
})

interface IpInfo {
  ip: string
  country_code: string
  country: string
  region: string
  city: string
  organization: string
  asn: number
  asn_organization: string
  longitude: number
  latitude: number
  timezone: string
}

const IP_CHECK_URL = 'https://api.ip.sb/geoip'
const IP_CHECK_TIMEOUT = 5000

export const getIpInfo = async (): Promise<
  IpInfo & { lastFetchTs: number }
> => {
  const userAgent = await getUserAgentPromise()

  return asyncRetry(
    async (bail) => {
      const timeoutController = new AbortController()
      const timeoutId = setTimeout(
        () => timeoutController.abort(),
        IP_CHECK_TIMEOUT,
      )

      try {
        const response = await fetchWithTimeout(
          IP_CHECK_URL,
          {
            method: 'GET',
            signal: timeoutController.signal,
            connectTimeout: IP_CHECK_TIMEOUT,
            headers: { 'User-Agent': userAgent },
          },
          IP_CHECK_TIMEOUT,
        )

        if (!response.ok) {
          return bail(new Error(`IP service failed (${response.status})`))
        }

        let data: Record<string, unknown>
        try {
          data = (await response.json()) as Record<string, unknown>
        } catch {
          return bail(new Error('IP service returned invalid JSON'))
        }

        if (typeof data['ip'] !== 'string') {
          return bail(new Error('IP service returned an invalid response'))
        }

        const text = (key: string) =>
          typeof data[key] === 'string' ? data[key] : ''
        const number = (key: string) =>
          typeof data[key] === 'number' ? data[key] : 0

        return {
          ip: text('ip'),
          country_code: text('country_code'),
          country: text('country'),
          region: text('region'),
          city: text('city'),
          organization: text('organization') || text('isp'),
          asn: number('asn'),
          asn_organization: text('asn_organization'),
          longitude: number('longitude'),
          latitude: number('latitude'),
          timezone: text('timezone'),
          lastFetchTs: Date.now(),
        }
      } finally {
        clearTimeout(timeoutId)
      }
    },
    {
      retries: 2,
      minTimeout: 1000,
      maxTimeout: 4000,
      randomize: true,
    },
  )
}
