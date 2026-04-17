import { Visibility, VisibilityOff } from '@mui/icons-material'
import {
  Box,
  Button,
  TextField,
  Typography,
  Divider,
  Alert,
  CircularProgress,
  InputAdornment,
  IconButton,
  Paper,
  Link as MuiLink,
  Stack,
} from '@mui/material'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
  useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useLocation, Link as RouterLink } from 'react-router'

import { apiLogin, apiGoogleOAuthCallback, AuthError } from '@/services/auth'
import { useAuth } from '@/services/auth-store'
import { openWebUrl } from '@/services/cmds'
import { syncSubscription } from '@/services/subscription-sync'

// ---------------------------------------------------------------------------
// Google OAuth configuration
// ---------------------------------------------------------------------------

const GOOGLE_CLIENT_ID =
  (import.meta.env['VITE_GOOGLE_CLIENT_ID'] as string | undefined) ??
  '19641496417-pktsiagj5d11nb4c719mbog1q1n2r5gj.apps.googleusercontent.com'

interface OAuthCallbackPayload {
  code?: string
  error?: string
  redirectUri?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LoginPage(): ReactNode {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const { setAuth, isAuthenticated } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)

  // Show a success banner when redirected from the register page.
  const registeredStateRef = useRef(
    Boolean((location.state as { registered?: boolean } | null)?.registered),
  )
  const [showRegistered, setShowRegistered] = useState(
    registeredStateRef.current,
  )

  // Track cancellation of an in-flight Google OAuth so the stale callback
  // never mutates auth state after the user aborted.
  const oauthCancelledRef = useRef(false)

  // Clear the router state after we've consumed it so a refresh/back-nav
  // does not re-show the banner.
  useEffect(() => {
    if (registeredStateRef.current) {
      window.history.replaceState({}, '')
    }
  }, [])

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      void navigate('/')
    }
  }, [isAuthenticated, navigate])

  // Listen for OAuth callback from the Rust side
  useEffect(() => {
    let unlisten: UnlistenFn | null = null
    let mounted = true

    listen<OAuthCallbackPayload>('oauth-callback', async (event) => {
      const { code, error: oauthError, redirectUri } = event.payload

      // If the user cancelled, ignore whatever the listener emits.
      if (oauthCancelledRef.current) {
        setGoogleLoading(false)
        return
      }

      if (oauthError) {
        setError(
          oauthError === 'access_denied'
            ? t('shared.auth.google.accessDenied')
            : t('shared.auth.google.authFailed', { error: oauthError }),
        )
        setGoogleLoading(false)
        return
      }

      if (!code || !redirectUri) {
        setError(t('shared.auth.google.missingCode'))
        setGoogleLoading(false)
        return
      }

      try {
        const result = await apiGoogleOAuthCallback(code, redirectUri)
        if (oauthCancelledRef.current) {
          return
        }
        setAuth(result.user, result.accessToken, result.refreshToken)
        syncSubscription().catch(console.error)
        void navigate('/')
      } catch (err) {
        if (oauthCancelledRef.current) {
          return
        }
        setError(
          err instanceof AuthError
            ? err.message
            : t('shared.auth.google.loginFailed', {
                error: err instanceof Error ? err.message : String(err),
              }),
        )
      } finally {
        setGoogleLoading(false)
      }
    })
      .then((fn) => {
        // If the component unmounted before the listener registered,
        // tear it down immediately to avoid a leak + duplicate handlers.
        if (!mounted) {
          fn()
          return
        }
        unlisten = fn
      })
      .catch(console.error)

    return () => {
      mounted = false
      if (unlisten) unlisten()
    }
  }, [setAuth, navigate, t])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await apiLogin(email, password)
      setAuth(result.user, result.accessToken, result.refreshToken)
      syncSubscription().catch(console.error)
      void navigate('/')
    } catch (err) {
      setError(
        err instanceof AuthError
          ? err.message
          : t('shared.auth.errors.loginFailed', {
              error: err instanceof Error ? err.message : String(err),
            }),
      )
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleLogin = async () => {
    if (!GOOGLE_CLIENT_ID) {
      setError(t('shared.auth.google.notConfigured'))
      return
    }
    setError('')
    oauthCancelledRef.current = false
    setGoogleLoading(true)
    // Use a placeholder redirect_uri — the Rust command will replace it
    // with the actual local server address (http://127.0.0.1:{port})
    const placeholderRedirect = 'http://127.0.0.1'
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: placeholderRedirect,
      response_type: 'code',
      scope: 'email profile',
      state: 'google',
      access_type: 'offline',
      prompt: 'select_account',
    })
    if (email) params.set('login_hint', email)
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
    try {
      await invoke<string>('open_oauth_window', {
        url,
        callbackUrlPrefix: placeholderRedirect,
      })
    } catch (err) {
      setError(
        t('shared.auth.errors.openBrowser', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      setGoogleLoading(false)
    }
  }

  const handleCancelGoogleLogin = () => {
    oauthCancelledRef.current = true
    setGoogleLoading(false)
    // TODO: no Rust-side command currently exists to close the OAuth
    // listener window / abort the local HTTP listener. The ref-based
    // guard above prevents any stale callback from mutating auth state.
  }

  const handleForgotPassword = () => {
    void openWebUrl('https://xxlink.dev/forgot-password')
  }

  const handleOpenTerms = () => {
    void openWebUrl('https://xxlink.dev/terms')
  }

  const handleOpenPrivacy = () => {
    void openWebUrl('https://xxlink.dev/privacy')
  }

  const anyLoading = loading || googleLoading

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
        sx={{ width: '100%', maxWidth: 420, p: 4, borderRadius: 3 }}
      >
        <Box sx={{ textAlign: 'center', mb: 3 }}>
          <Typography
            variant="h5"
            fontWeight={700}
            sx={{ color: '#4f46e5', letterSpacing: 1 }}
          >
            {t('shared.auth.brand')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {t('shared.auth.login.subtitle')}
          </Typography>
        </Box>

        {showRegistered && (
          <Alert
            severity="success"
            sx={{ mb: 2 }}
            onClose={() => setShowRegistered(false)}
          >
            {t('shared.auth.registeredSuccess')}
          </Alert>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Box component="form" onSubmit={handleSubmit} noValidate>
          <TextField
            label={t('shared.auth.form.email')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            fullWidth
            autoFocus
            disabled={anyLoading}
            sx={{ mb: 2 }}
          />
          <TextField
            label={t('shared.auth.form.password')}
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            fullWidth
            disabled={anyLoading}
            sx={{ mb: 1 }}
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={() => setShowPassword((v) => !v)}
                      edge="end"
                      tabIndex={-1}
                      aria-label={
                        showPassword
                          ? t('shared.auth.form.hidePassword')
                          : t('shared.auth.form.showPassword')
                      }
                    >
                      {showPassword ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />
          <Box sx={{ textAlign: 'right', mb: 2 }}>
            <MuiLink
              component="button"
              type="button"
              variant="body2"
              onClick={handleForgotPassword}
              sx={{
                color: '#4f46e5',
                fontWeight: 500,
                textDecoration: 'none',
                '&:hover': { textDecoration: 'underline' },
              }}
            >
              {t('shared.auth.forgotPassword')}
            </MuiLink>
          </Box>
          <Button
            type="submit"
            variant="contained"
            fullWidth
            disabled={anyLoading}
            sx={{
              py: 1.2,
              bgcolor: '#4f46e5',
              '&:hover': { bgcolor: '#4338ca' },
              fontWeight: 600,
              fontSize: 15,
            }}
          >
            {loading ? (
              <CircularProgress size={22} color="inherit" />
            ) : (
              t('shared.auth.login.submit')
            )}
          </Button>
        </Box>

        <Divider sx={{ my: 2.5 }}>
          <Typography variant="caption" color="text.secondary">
            {t('shared.auth.login.dividerText')}
          </Typography>
        </Divider>
        {googleLoading ? (
          <Button
            variant="outlined"
            fullWidth
            onClick={handleCancelGoogleLogin}
            startIcon={<CircularProgress size={18} />}
            sx={{
              py: 1.2,
              borderColor: '#ef4444',
              color: '#ef4444',
              fontWeight: 500,
              '&:hover': { borderColor: '#dc2626', bgcolor: '#fef2f2' },
            }}
          >
            {t('shared.auth.cancelGoogleLogin')}
          </Button>
        ) : (
          <Button
            variant="outlined"
            fullWidth
            onClick={handleGoogleLogin}
            disabled={loading}
            startIcon={<GoogleIcon />}
            sx={{
              py: 1.2,
              borderColor: '#d1d5db',
              color: 'text.primary',
              fontWeight: 500,
              '&:hover': { borderColor: '#9ca3af', bgcolor: '#f9fafb' },
            }}
          >
            {t('shared.auth.google.signIn')}
          </Button>
        )}

        <Typography
          variant="body2"
          textAlign="center"
          sx={{ mt: 3 }}
          color="text.secondary"
        >
          {t('shared.auth.login.noAccount')}{' '}
          <RouterLink
            to="/register"
            style={{
              color: '#4f46e5',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            {t('shared.auth.login.goRegister')}
          </RouterLink>
        </Typography>

        <Stack
          direction="row"
          spacing={2}
          justifyContent="center"
          sx={{ mt: 2 }}
        >
          <MuiLink
            component="button"
            type="button"
            variant="caption"
            onClick={handleOpenTerms}
            sx={{
              color: 'text.secondary',
              textDecoration: 'none',
              '&:hover': { textDecoration: 'underline' },
            }}
          >
            {t('shared.legal.terms')}
          </MuiLink>
          <MuiLink
            component="button"
            type="button"
            variant="caption"
            onClick={handleOpenPrivacy}
            sx={{
              color: 'text.secondary',
              textDecoration: 'none',
              '&:hover': { textDecoration: 'underline' },
            }}
          >
            {t('shared.legal.privacy')}
          </MuiLink>
        </Stack>
      </Paper>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Inline Google brand icon (no external dependency)
// ---------------------------------------------------------------------------

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  )
}
