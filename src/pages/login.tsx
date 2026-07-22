import { Visibility, VisibilityOff } from '@mui/icons-material'
import {
  Box,
  Button,
  TextField,
  Typography,
  Alert,
  CircularProgress,
  InputAdornment,
  IconButton,
  Paper,
} from '@mui/material'
import { useState, type FormEvent, type ReactNode, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, Link as RouterLink } from 'react-router'

import { AuthError } from '@/services/auth'
import { useAuth } from '@/services/auth-store'
import {
  classifyClientError,
  reportSafeClientFailure,
  toSafeClientErrorMessage,
} from '@/services/safe-client-error'
import { signInWithSecureSession } from '@/services/secure-session-controller'
import { SESSION_EXPIRED_MESSAGE_KEY } from '@/services/session'
import { syncSubscription } from '@/services/subscription-sync'

const getLoginErrorMessage = (
  err: unknown,
  t: (key: string) => string,
): string => {
  if (err instanceof AuthError) {
    if (err.status === 401 || err.status === 403) {
      return t('shared.auth.errors.invalidCredentials')
    }
  }

  return toSafeClientErrorMessage(classifyClientError(err).kind, t)
}

export default function LoginPage(): ReactNode {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { isAuthenticated } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(() => {
    try {
      const message = localStorage.getItem(SESSION_EXPIRED_MESSAGE_KEY)
      if (!message) return ''
      localStorage.removeItem(SESSION_EXPIRED_MESSAGE_KEY)
      return toSafeClientErrorMessage('auth', t)
    } catch {
      return ''
    }
  })
  const [loading, setLoading] = useState(false)

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      void navigate('/')
    }
  }, [isAuthenticated, navigate])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signInWithSecureSession(email, password)
      syncSubscription({ force: true, timeoutMs: 10_000 }).catch((error) =>
        reportSafeClientFailure('login-subscription-sync', error),
      )
      void navigate('/')
    } catch (err) {
      reportSafeClientFailure('login-submit', err)
      setError(getLoginErrorMessage(err, t))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: '#f0f2ff',
        p: 2,
      }}
    >
      <Paper
        elevation={3}
        sx={{
          width: '100%',
          maxWidth: 420,
          p: 4,
          borderRadius: 3,
        }}
      >
        {/* Header */}
        <Box sx={{ textAlign: 'center', mb: 3 }}>
          <Typography
            variant="h5"
            fontWeight={700}
            sx={{ color: '#4f46e5', letterSpacing: 1 }}
          >
            XXLink
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            登录以继续使用
          </Typography>
        </Box>

        {/* Error alert */}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Login form */}
        <Box component="form" onSubmit={handleSubmit} noValidate>
          <TextField
            label="邮箱"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            fullWidth
            autoFocus
            disabled={loading}
            sx={{ mb: 2 }}
          />
          <TextField
            label="密码"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            fullWidth
            disabled={loading}
            sx={{ mb: 3 }}
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={() => setShowPassword((v) => !v)}
                      edge="end"
                      tabIndex={-1}
                      aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    >
                      {showPassword ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />
          <Button
            type="submit"
            variant="contained"
            fullWidth
            disabled={loading}
            sx={{
              py: 1.2,
              bgcolor: '#4f46e5',
              '&:hover': { bgcolor: '#4338ca' },
              fontWeight: 600,
              fontSize: 15,
            }}
          >
            {loading ? <CircularProgress size={22} color="inherit" /> : '登录'}
          </Button>
        </Box>

        {/* Footer link */}
        <Typography
          variant="body2"
          textAlign="center"
          sx={{ mt: 3 }}
          color="text.secondary"
        >
          还没有账号？{' '}
          <RouterLink
            to="/register"
            style={{
              color: '#4f46e5',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            立即注册
          </RouterLink>
        </Typography>
      </Paper>
    </Box>
  )
}
