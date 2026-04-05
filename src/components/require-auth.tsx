import { type ReactNode } from 'react'
import { Navigate } from 'react-router'

import { authStore } from '@/services/auth-store'

/**
 * Auth guard component — redirects unauthenticated users to /login.
 * Used as the root Layout wrapper so all protected routes are covered.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = authStore.getState()
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}
