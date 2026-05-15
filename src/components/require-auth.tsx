import { useEffect, type ReactNode } from 'react'
import { useNavigate } from 'react-router'

import { hideInitialOverlay } from '@/pages/_layout/utils'
import { useAuth } from '@/services/auth-store'

/**
 * Auth guard component — redirects unauthenticated users to /login.
 * Used as the root Layout wrapper so all protected routes are covered.
 *
 * Subscribes to the auth store so that mid-session token expiry (e.g. an
 * interceptor calling `authStore.clearAuth()`) immediately redirects the
 * tree to /login instead of rendering stale content.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!isAuthenticated) {
      hideInitialOverlay({ assumeMissingAsRemoved: true })
      navigate('/login', { replace: true })
    }
  }, [isAuthenticated, navigate])

  if (!isAuthenticated) {
    hideInitialOverlay({ assumeMissingAsRemoved: true })
    return null
  }
  return <>{children}</>
}
