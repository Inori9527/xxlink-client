import { open } from '@tauri-apps/plugin-shell'

import type { Announcement, AnnouncementLevel } from '@/services/api'
import { showNotice } from '@/services/notice-service'

export type AnnouncementType = 'BROADCAST' | 'UPDATE'

const SITE_ORIGIN = 'https://xxlink.net'
const HISTORY_LIMIT = 20
const LEGACY_DISMISSED_KEY = 'xxlink:dismissed-announcement-id'
const LEGACY_HISTORY_KEY = 'xxlink:announcement-history'
const LEVELS = new Set<AnnouncementLevel>([
  'info',
  'success',
  'warning',
  'error',
])

const cacheKey = (
  type: AnnouncementType,
  scope: 'history' | 'dismissed' | 'read',
) => `xxlink:announcement:${scope}:${type}`

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
    const raw = localStorage.getItem(cacheKey(type, 'history'))
    if (!raw) return []
    const list = JSON.parse(raw) as Announcement[]
    return Array.isArray(list) ? list.filter((item) => item?.id) : []
  } catch {
    return []
  }
}

export const rememberAnnouncementHistory = (
  type: AnnouncementType,
  items: Array<Announcement | null | undefined>,
): Announcement[] => {
  const validItems = items.filter((item): item is Announcement =>
    Boolean(item?.id),
  )
  const existing = readAnnouncementHistory(type)
  const next = [
    ...validItems,
    ...existing.filter(
      (item) => !validItems.some((candidate) => candidate.id === item.id),
    ),
  ].slice(0, HISTORY_LIMIT)

  try {
    localStorage.setItem(cacheKey(type, 'history'), JSON.stringify(next))
  } catch {
    /* ignore */
  }

  return next
}

export const replaceAnnouncementHistory = (
  type: AnnouncementType,
  items: Announcement[],
): Announcement[] => {
  const next = items.filter((item) => item?.id).slice(0, HISTORY_LIMIT)

  try {
    localStorage.setItem(cacheKey(type, 'history'), JSON.stringify(next))
  } catch {
    /* ignore */
  }

  return next
}

export const getDismissedAnnouncementId = (
  type: AnnouncementType,
): string | null => {
  try {
    const current = localStorage.getItem(cacheKey(type, 'dismissed'))
    if (current || type !== 'BROADCAST') return current

    const legacy = localStorage.getItem(LEGACY_DISMISSED_KEY)
    if (legacy) {
      localStorage.setItem(cacheKey(type, 'dismissed'), legacy)
    }
    return legacy
  } catch {
    return null
  }
}

export const setDismissedAnnouncementId = (
  type: AnnouncementType,
  id: string,
) => {
  try {
    localStorage.setItem(cacheKey(type, 'dismissed'), id)
  } catch {
    /* ignore */
  }
}

export const migrateLegacyBroadcastHistory = () => {
  try {
    if (readAnnouncementHistory('BROADCAST').length > 0) return
    const raw = localStorage.getItem(LEGACY_HISTORY_KEY)
    if (!raw) return
    const list = JSON.parse(raw) as Announcement[]
    if (Array.isArray(list)) {
      rememberAnnouncementHistory('BROADCAST', list)
    }
  } catch {
    /* ignore */
  }
}

export const readAnnouncementIds = (
  type: AnnouncementType,
  scope: 'read',
): Set<string> => {
  try {
    const raw = localStorage.getItem(cacheKey(type, scope))
    if (!raw) return new Set()
    const ids = JSON.parse(raw) as string[]
    return new Set(Array.isArray(ids) ? ids.filter(Boolean) : [])
  } catch {
    return new Set()
  }
}

export const markAnnouncementRead = (
  type: AnnouncementType,
  id: string,
): Set<string> => {
  const ids = readAnnouncementIds(type, 'read')
  ids.add(id)

  try {
    localStorage.setItem(cacheKey(type, 'read'), JSON.stringify([...ids]))
  } catch {
    /* ignore */
  }

  return ids
}

export const openAnnouncementAction = async (
  actionUrl?: string | null,
): Promise<void> => {
  if (!actionUrl) return

  try {
    if (actionUrl.startsWith('//')) {
      throw new Error('Protocol-relative URLs are not allowed')
    }

    const url =
      actionUrl.startsWith('https://') || actionUrl.startsWith('/')
        ? new URL(actionUrl, SITE_ORIGIN)
        : null

    if (!url || url.protocol !== 'https:') {
      throw new Error('Only HTTPS announcement links are allowed')
    }

    await open(url.toString())
  } catch {
    showNotice.info('无法打开此公告链接')
  }
}
