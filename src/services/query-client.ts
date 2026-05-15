import { QueryClient } from '@tanstack/react-query'

import { ApiError, isAuthFatalError } from '@/services/api'

const shouldRetryQuery = (failureCount: number, error: unknown): boolean => {
  if (isAuthFatalError(error)) return false
  if ((error as { code?: string } | null)?.code === 'NETWORK_TIMEOUT') return false
  if (
    error instanceof ApiError &&
    (error.status === 404 ||
      error.code === 'MALFORMED_RESPONSE' ||
      error.code === 'NETWORK_TIMEOUT')
  ) {
    return false
  }
  return failureCount < 2
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      retry: shouldRetryQuery,
      retryDelay: 5000,
      refetchOnWindowFocus: false,
    },
  },
})
