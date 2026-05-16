import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'

import { router } from '@/pages/_routers'
import { api, ApiError } from '@/services/api'
import { authStore, useAuth } from '@/services/auth-store'
import { showNotice } from '@/services/notice-service'

const WEB_LOGIN_EVENT = 'xxlink://web-login'
const PAIRING_CODE_PATTERN = /^\d{6}$/

type WebLoginPayload = {
  attemptId?: string
  state?: string
  challenge?: string
  url?: string
}

type WebLoginRequest = {
  attemptId: string
  state: string
  challenge: string
}

type ApprovalState = 'idle' | 'submitting' | 'approved' | 'error'

function parseWebLoginUrl(rawUrl: string): WebLoginRequest | null {
  try {
    const url = new URL(rawUrl)
    const isWebLogin =
      url.protocol === 'xxlink:' &&
      (url.hostname === 'web-login' ||
        url.pathname.replace(/^\/+/, '') === 'web-login')

    if (!isWebLogin) return null

    const attemptId = url.searchParams.get('attemptId')?.trim()
    const state = url.searchParams.get('state')?.trim()
    const challenge = url.searchParams.get('challenge')?.trim()

    if (!attemptId || !state || !challenge) return null
    return { attemptId, state, challenge }
  } catch {
    return null
  }
}

function getWebLoginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'UNTRUSTED_API_HOST') {
      return '网页登录只支持 XXLink 官方服务'
    }

    if (error.status === 401 || error.code === 'SESSION_EXPIRED') {
      return '登录状态已失效，请重新登录后重试'
    }

    if (error.status === 404 && error.code === 'CLIENT_LOGIN_EXPIRED') {
      return '登录请求已过期，请回网页重试'
    }

    if (
      error.status === 403 &&
      (error.code === 'CLIENT_LOGIN_MISMATCH' ||
        error.code === 'CLIENT_LOGIN_CONFIRMATION_REQUIRED')
    ) {
      return '登录码或请求不匹配'
    }

    if (error.status === 409 && error.code === 'CLIENT_LOGIN_NOT_PENDING') {
      return '该请求已被处理'
    }
  }

  return '网页登录确认失败，请回网页重试'
}

function extractEventRequest(
  payload: WebLoginPayload | string,
): WebLoginRequest | null {
  if (typeof payload === 'string') return parseWebLoginUrl(payload)
  if (!payload) return null
  if (
    typeof payload.attemptId === 'string' &&
    typeof payload.state === 'string' &&
    typeof payload.challenge === 'string'
  ) {
    const attemptId = payload.attemptId.trim()
    const state = payload.state.trim()
    const challenge = payload.challenge.trim()
    if (attemptId && state && challenge) {
      return { attemptId, state, challenge }
    }
  }
  if (typeof payload.url === 'string') return parseWebLoginUrl(payload.url)
  return null
}

export function ClientWebLoginPrompt() {
  const theme = useTheme()
  const { isAuthenticated } = useAuth()
  const isAuthenticatedRef = useRef(isAuthenticated)
  const [pendingRequest, setPendingRequest] = useState<WebLoginRequest | null>(
    null,
  )
  const [request, setRequest] = useState<WebLoginRequest | null>(null)
  const [pairingCode, setPairingCode] = useState('')
  const [approvalState, setApprovalState] = useState<ApprovalState>('idle')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    isAuthenticatedRef.current = isAuthenticated
  }, [isAuthenticated])

  useEffect(() => {
    if (!isAuthenticated || !pendingRequest || request) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setRequest(pendingRequest)
      setPendingRequest(null)
      setPairingCode('')
      setApprovalState('idle')
      setMessage(null)
    })
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, pendingRequest, request])

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined

    void listen<WebLoginPayload | string>(WEB_LOGIN_EVENT, (event) => {
      const nextRequest = extractEventRequest(event.payload)

      if (!nextRequest) {
        showNotice.error('网页登录请求无效，请回网页重试')
        return
      }

      if (!isAuthenticatedRef.current) {
        setPendingRequest(nextRequest)
        showNotice.info('请先登录 XXLink 客户端，登录后继续确认网页登录')
        void router.navigate('/login')
        return
      }

      setRequest(nextRequest)
      setPairingCode('')
      setApprovalState('idle')
      setMessage(null)
    }).then((dispose) => {
      if (active) {
        unlisten = dispose
      } else {
        dispose()
      }
    })

    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  const handleClose = useCallback(() => {
    if (approvalState === 'submitting') return
    setRequest(null)
    setPairingCode('')
    setApprovalState('idle')
    setMessage(null)
  }, [approvalState])

  const handlePairingCodeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setPairingCode(event.target.value.replace(/\D/g, '').slice(0, 6))
      if (approvalState === 'error') {
        setApprovalState('idle')
        setMessage(null)
      }
    },
    [approvalState],
  )

  const handleConfirm = useCallback(async () => {
    if (!request || !PAIRING_CODE_PATTERN.test(pairingCode)) return

    if (!authStore.getState().isAuthenticated) {
      setPendingRequest(request)
      showNotice.info('请先登录 XXLink 客户端，登录后继续确认网页登录')
      handleClose()
      void router.navigate('/login')
      return
    }

    setApprovalState('submitting')
    setMessage(null)

    try {
      const version = await getVersion().catch(() => null)
      const result = await api.clientWebLogin.approveTicket({
        attemptId: request.attemptId,
        state: request.state,
        challenge: request.challenge,
        pairingCode,
        confirmed: true,
        deviceName: version ? `Windows client ${version}` : 'Windows client',
      })

      setApprovalState('approved')
      setMessage(
        result.status === 'APPROVED'
          ? '已确认，请回到浏览器继续'
          : '请求已处理，请回到浏览器继续',
      )
    } catch (error) {
      setApprovalState('error')
      setMessage(getWebLoginErrorMessage(error))
    }
  }, [handleClose, pairingCode, request])

  const canConfirm =
    Boolean(request) &&
    PAIRING_CODE_PATTERN.test(pairingCode) &&
    approvalState !== 'submitting' &&
    approvalState !== 'approved'

  return (
    <Dialog
      open={Boolean(request)}
      onClose={handleClose}
      fullWidth
      maxWidth="xs"
      PaperProps={{
        sx: {
          borderRadius: 4,
          border: `1px solid ${alpha(theme.palette.primary.main, 0.2)}`,
          background:
            theme.palette.mode === 'dark'
              ? 'linear-gradient(145deg, rgba(10,20,32,0.98), rgba(12,28,36,0.98))'
              : 'linear-gradient(145deg, #F8FDFF, #FFFFFF)',
        },
      }}
    >
      <DialogTitle sx={{ pb: 1, fontWeight: 900 }}>
        XXLink 官方网页登录
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            请核对网页上显示的 6 位登录码，并在这里输入。
          </Typography>

          <Box
            sx={{
              p: 1.5,
              borderRadius: 3,
              bgcolor: alpha(theme.palette.primary.main, 0.08),
              border: `1px solid ${alpha(theme.palette.primary.main, 0.16)}`,
            }}
          >
            <Typography variant="caption" color="text.secondary">
              仅确认本次网页登录，不会授权其他操作。
            </Typography>
          </Box>

          <TextField
            autoFocus
            fullWidth
            label="6 位登录码"
            value={pairingCode}
            onChange={handlePairingCodeChange}
            disabled={
              approvalState === 'submitting' || approvalState === 'approved'
            }
            slotProps={{
              htmlInput: {
                inputMode: 'numeric',
                maxLength: 6,
                pattern: '[0-9]*',
                autoComplete: 'one-time-code',
              },
            }}
          />

          {message && (
            <Alert
              severity={approvalState === 'approved' ? 'success' : 'error'}
              sx={{ borderRadius: 3 }}
            >
              {message}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={handleClose} disabled={approvalState === 'submitting'}>
          {approvalState === 'approved' ? '关闭' : '取消'}
        </Button>
        {approvalState !== 'approved' && (
          <Button
            variant="contained"
            onClick={() => void handleConfirm()}
            disabled={!canConfirm}
            sx={{ borderRadius: 999, fontWeight: 900, px: 2.5 }}
          >
            {approvalState === 'submitting' ? '确认中' : '确认登录'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
