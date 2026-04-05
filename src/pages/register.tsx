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
import { useNavigate, Link as RouterLink } from 'react-router'

import { apiRegister, AuthError } from '@/services/auth'
import { useAuth } from '@/services/auth-store'

export default function RegisterPage(): ReactNode {
  const navigate = useNavigate()
  const { isAuthenticated } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState('')
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

    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    if (password.length < 8) {
      setError('密码至少需要 8 位字符')
      return
    }

    setLoading(true)
    try {
      await apiRegister(email, password)
      // After registration redirect to login so the user can sign in
      void navigate('/login', { state: { registered: true } })
    } catch (err) {
      setError(
        err instanceof AuthError
          ? err.message
          : `注册失败: ${err instanceof Error ? err.message : String(err)}`,
      )
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
            创建新账号
          </Typography>
        </Box>

        {/* Error alert */}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Register form */}
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
            placeholder="至少 8 位字符"
            required
            fullWidth
            disabled={loading}
            sx={{ mb: 2 }}
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
          <TextField
            label="确认密码"
            type={showConfirm ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
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
                      onClick={() => setShowConfirm((v) => !v)}
                      edge="end"
                      tabIndex={-1}
                      aria-label={showConfirm ? '隐藏密码' : '显示密码'}
                    >
                      {showConfirm ? <VisibilityOff /> : <Visibility />}
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
            {loading ? (
              <CircularProgress size={22} color="inherit" />
            ) : (
              '创建账号'
            )}
          </Button>
        </Box>

        {/* Footer link */}
        <Typography
          variant="body2"
          textAlign="center"
          sx={{ mt: 3 }}
          color="text.secondary"
        >
          已有账号？{' '}
          <RouterLink
            to="/login"
            style={{
              color: '#4f46e5',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            立即登录
          </RouterLink>
        </Typography>
      </Paper>
    </Box>
  )
}
