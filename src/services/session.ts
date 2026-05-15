import { authStore } from '@/services/auth-store'

export const SESSION_EXPIRED_MESSAGE_KEY = 'xxlink:session-expired-message'

export type SessionExpiredDetail = {
  message: string
  code?: string
  status?: number
}

export const SESSION_EXPIRED_EVENT = 'xxlink:session-expired'

export function expireSession(detail: SessionExpiredDetail): void {
  authStore.clearAuth()
  try {
    localStorage.setItem(SESSION_EXPIRED_MESSAGE_KEY, detail.message)
    localStorage.removeItem('xxlink:last-sync-error')
    window.dispatchEvent(new CustomEvent('xxlink:last-sync-error-changed'))
    window.dispatchEvent(
      new CustomEvent<SessionExpiredDetail>(SESSION_EXPIRED_EVENT, {
        detail,
      }),
    )
  } catch {
    /* ignore */
  }
}
