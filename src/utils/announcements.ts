import { open } from '@tauri-apps/plugin-shell'

import type { Announcement, AnnouncementLevel } from '@/services/api'
import { showNotice } from '@/services/notice-service'

export type AnnouncementType = 'BROADCAST' | 'UPDATE'

const SITE_ORIGIN = 'https://xxlink.net'
const HISTORY_LIMIT = 20
const ANNOUNCEMENT_HISTORY_KEY_PREFIX = 'xxlink:announcement:history:'
const ANNOUNCEMENT_DISMISSED_KEY_PREFIX = 'xxlink:announcement:dismissed:'
const ANNOUNCEMENT_READ_KEY_PREFIX = 'xxlink:announcement:read:'

const LEVELS: ReadonlySet<AnnouncementLevel> = new Set([
  'info',
  'success',
  'warning',
  'error',
])

const getHistoryKey = (type: AnnouncementType) =>
  `${ANNOUNCEMENT_HISTORY_KEY_PREFIX}${type}`

const getDismissedKey = (type: AnnouncementType) =>
  `${ANNOUNCEMENT_DISMISSED_KEY_PREFIX}${type}`

const getReadKey = (type: AnnouncementType) =>
  `${ANNOUNCEMENT_READ_KEY_PREFIX}${type}`

export const normalizeAnnouncementLevel = (
  level: Announcement['level'],
): AnnouncementLevel => {
  return LEVELS.has(level as AnnouncementLevel)
    ? (level as AnnouncementLevel)
    : 'info'
}

export const readAnnouncementHistory = (
  type: AnnouncementType,
): Announcement[] => {
  try {
    const raw = localStorage.getItem(getHistoryKey(type))
    if (!raw) return []
    const list = JSON.parse(raw) as Announcement[]
    return Array.isArray(list) ? list.filter((item) => item?.id) : []
  } catch {
    return []
  }
}

export const rememberAnnouncementHistory = (
  type: AnnouncementType,
  announcements: Announcement | Announcement[] | null | undefined,
): Announcement[] => {
  const incoming = Array.isArray(announcements)
    ? announcements
    : announcements
      ? [announcements]
      : []
  const validIncoming = incoming.filter((item) => item?.id)
  if (validIncoming.length === 0) return readAnnouncementHistory(type)

  const existing = readAnnouncementHistory(type)
  const merged = [...validIncoming, ...existing]
  const seen = new Set<string>()
  const next = merged
    .filter((item) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    .slice(0, HISTORY_LIMIT)

  try {
    localStorage.setItem(getHistoryKey(type), JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}

export const getDismissedAnnouncementId = (
  type: AnnouncementType,
): string | null => {
  try {
    return localStorage.getItem(getDismissedKey(type))
  } catch {
    return null
  }
}

export const setDismissedAnnouncementId = (
  type: AnnouncementType,
  id: string,
) => {
  try {
    localStorage.setItem(getDismissedKey(type), id)
  } catch {
    /* ignore */
  }
}

export const readAnnouncementIds = (type: AnnouncementType): Set<string> => {
  try {
    const raw = localStorage.getItem(getReadKey(type))
    if (!raw) return new Set()
    const list = JSON.parse(raw) as string[]
    return new Set(Array.isArray(list) ? list.filter(Boolean) : [])
  } catch {
    return new Set()
  }
}

export const markAnnouncementRead = (
  type: AnnouncementType,
  id: string,
): Set<string> => {
  const next = new Set(readAnnouncementIds(type))
  next.add(id)
  try {
    localStorage.setItem(
      getReadKey(type),
      JSON.stringify([...next].slice(-100)),
    )
  } catch {
    /* ignore */
  }
  return next
}

export const openAnnouncementAction = async (
  actionUrl: string | null | undefined,
) => {
  if (!actionUrl) return false

  try {
    const trimmedUrl = actionUrl.trim()
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmedUrl)
    const targetUrl =
      !hasScheme && !trimmedUrl.startsWith('//')
        ? new URL(trimmedUrl, SITE_ORIGIN)
        : new URL(trimmedUrl)

    if (targetUrl.protocol !== 'https:') {
      showNotice.info('无法打开此公告链接')
      return false
    }

    await open(targetUrl.toString())
    return true
  } catch {
    showNotice.info('无法打开此公告链接')
    return false
  }
}
