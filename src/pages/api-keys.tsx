import AddIcon from '@mui/icons-material/Add'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import DeleteIcon from '@mui/icons-material/Delete'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Paper,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useEffect, useState } from 'react'

import { BasePage } from '@/components/base'
import { api, type ApiKey, type ApiKeyUsage } from '@/services/api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskKey(key: string): string {
  if (key.length <= 12) return key
  return `${key.slice(0, 8)}****${key.slice(-4)}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

function formatCost(cents: number): string {
  return `¥${(cents / 100).toFixed(4)}`
}

// ---------------------------------------------------------------------------
// Usage Summary Card
// ---------------------------------------------------------------------------

interface UsageSummaryCardProps {
  usage: ApiKeyUsage | null
  loading: boolean
}

const UsageSummaryCard = ({ usage, loading }: UsageSummaryCardProps) => (
  <Paper
    elevation={0}
    sx={{
      p: 3,
      mb: 3,
      border: '1px solid',
      borderColor: 'divider',
      borderRadius: 2,
    }}
  >
    <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 2 }}>
      使用统计
    </Typography>
    <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      <StatBox
        label="总请求数"
        value={
          loading ? null : (usage?.totalRequests.toLocaleString('zh-CN') ?? '0')
        }
      />
      <StatBox
        label="总 Token 数"
        value={
          loading ? null : (usage?.totalTokens.toLocaleString('zh-CN') ?? '0')
        }
      />
      <StatBox
        label="今日请求"
        value={
          loading ? null : (usage?.todayRequests.toLocaleString('zh-CN') ?? '0')
        }
      />
      <StatBox
        label="今日费用"
        value={loading ? null : formatCost(usage?.todayCost ?? 0)}
      />
    </Box>
  </Paper>
)

const StatBox = ({ label, value }: { label: string; value: string | null }) => (
  <Box>
    <Typography variant="caption" color="text.secondary" display="block">
      {label}
    </Typography>
    {value === null ? (
      <Skeleton width={80} height={28} />
    ) : (
      <Typography variant="h6" fontWeight={700}>
        {value}
      </Typography>
    )}
  </Box>
)

// ---------------------------------------------------------------------------
// Key Row
// ---------------------------------------------------------------------------

interface KeyRowProps {
  apiKey: ApiKey
  onDelete: (id: string) => void
  onCopied: () => void
}

const KeyRow = ({ apiKey, onDelete, onCopied }: KeyRowProps) => {
  const [revealed, setRevealed] = useState(false)

  const handleCopy = async () => {
    try {
      await writeText(apiKey.key)
      onCopied()
    } catch {
      // ignore
    }
  }

  return (
    <TableRow hover>
      <TableCell>
        <Typography variant="body2" fontWeight={600}>
          {apiKey.name}
        </Typography>
      </TableCell>

      <TableCell>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Typography
            variant="body2"
            fontFamily="monospace"
            sx={{ userSelect: revealed ? 'text' : 'none' }}
          >
            {revealed ? apiKey.key : maskKey(apiKey.key)}
          </Typography>
          <Tooltip title={revealed ? '隐藏' : '显示'}>
            <IconButton
              size="small"
              onClick={() => setRevealed((v) => !v)}
              sx={{ color: 'text.secondary' }}
            >
              {revealed ? (
                <VisibilityOffIcon fontSize="small" />
              ) : (
                <VisibilityIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
          <Tooltip title="复制密钥">
            <IconButton
              size="small"
              onClick={handleCopy}
              sx={{ color: '#4f46e5' }}
            >
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </TableCell>

      <TableCell>
        <Typography variant="body2" color="text.secondary">
          {formatDate(apiKey.createdAt)}
        </Typography>
      </TableCell>

      <TableCell>
        <Typography variant="body2" color="text.secondary">
          {apiKey.lastUsedAt ? formatDate(apiKey.lastUsedAt) : '从未使用'}
        </Typography>
      </TableCell>

      <TableCell>
        <Typography variant="body2">
          {apiKey.requestCount.toLocaleString('zh-CN')}
        </Typography>
      </TableCell>

      <TableCell align="right">
        <Tooltip title="删除密钥">
          <IconButton
            size="small"
            color="error"
            onClick={() => onDelete(apiKey.id)}
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </TableCell>
    </TableRow>
  )
}

// ---------------------------------------------------------------------------
// Create Key Dialog
// ---------------------------------------------------------------------------

interface CreateKeyDialogProps {
  open: boolean
  onClose: () => void
  onCreated: (key: ApiKey) => void
  onError: (msg: string) => void
}

const CreateKeyDialog = ({
  open,
  onClose,
  onCreated,
  onError,
}: CreateKeyDialogProps) => {
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [newKey, setNewKey] = useState<ApiKey | null>(null)
  const [copied, setCopied] = useState(false)

  const handleCreate = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      const key = await api.apiKeys.create(name.trim())
      setNewKey(key)
      onCreated(key)
    } catch (err) {
      onError(err instanceof Error ? err.message : '创建密钥失败')
      handleClose()
    } finally {
      setCreating(false)
    }
  }

  const handleCopy = async () => {
    if (!newKey) return
    try {
      await writeText(newKey.key)
      setCopied(true)
    } catch {
      // ignore
    }
  }

  const handleClose = () => {
    setName('')
    setNewKey(null)
    setCopied(false)
    onClose()
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      {newKey ? (
        <>
          <DialogTitle>密钥已创建</DialogTitle>
          <DialogContent>
            <Alert severity="warning" sx={{ mb: 2 }}>
              请保存密钥，关闭后将无法再次查看
            </Alert>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              密钥名称：{newKey.name}
            </Typography>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                p: 1.5,
                borderRadius: 1,
                bgcolor: 'action.hover',
                border: '1px solid',
                borderColor: 'divider',
              }}
            >
              <Typography
                variant="body2"
                fontFamily="monospace"
                sx={{ flex: 1, wordBreak: 'break-all', fontSize: '0.8rem' }}
              >
                {newKey.key}
              </Typography>
              <Tooltip title={copied ? '已复制' : '复制'}>
                <IconButton
                  size="small"
                  onClick={handleCopy}
                  sx={{ color: '#4f46e5', flexShrink: 0 }}
                >
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
            {copied && (
              <Typography
                variant="caption"
                sx={{ color: 'success.main', mt: 0.5, display: 'block' }}
              >
                已复制到剪贴板
              </Typography>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              onClick={handleClose}
              variant="contained"
              sx={{ bgcolor: '#4f46e5', '&:hover': { bgcolor: '#4338ca' } }}
            >
              我已保存，关闭
            </Button>
          </DialogActions>
        </>
      ) : (
        <>
          <DialogTitle>创建新密钥</DialogTitle>
          <DialogContent>
            <DialogContentText sx={{ mb: 2 }}>
              为密钥指定一个便于识别的名称，例如"生产环境"或"测试"。
            </DialogContentText>
            <TextField
              autoFocus
              fullWidth
              label="密钥名称"
              size="small"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  void handleCreate()
                }
              }}
              placeholder="例如：生产环境"
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose} color="inherit">
              取消
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!name.trim() || creating}
              variant="contained"
              sx={{ bgcolor: '#4f46e5', '&:hover': { bgcolor: '#4338ca' } }}
            >
              {creating ? '创建中…' : '创建'}
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Confirm Delete Dialog
// ---------------------------------------------------------------------------

interface ConfirmDeleteDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => Promise<void>
  deleting: boolean
}

const ConfirmDeleteDialog = ({
  open,
  onClose,
  onConfirm,
  deleting,
}: ConfirmDeleteDialogProps) => (
  <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
    <DialogTitle>确认删除</DialogTitle>
    <DialogContent>
      <DialogContentText>
        删除后该密钥将立即失效，相关应用将无法再使用此密钥。此操作不可撤销。
      </DialogContentText>
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose} color="inherit" disabled={deleting}>
        取消
      </Button>
      <Button
        onClick={onConfirm}
        color="error"
        variant="contained"
        disabled={deleting}
      >
        {deleting ? '删除中…' : '确认删除'}
      </Button>
    </DialogActions>
  </Dialog>
)

// ---------------------------------------------------------------------------
// API Keys Page
// ---------------------------------------------------------------------------

const ApiKeysPage = () => {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [usage, setUsage] = useState<ApiKeyUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const [keysData, usageData] = await Promise.all([
          api.apiKeys.list(),
          api.apiKeys.usage(),
        ])
        setKeys(keysData)
        setUsage(usageData)
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败，请稍后重试')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const handleCreated = (key: ApiKey) => {
    setKeys((prev) => [key, ...prev])
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTargetId) return
    setDeleting(true)
    try {
      await api.apiKeys.delete(deleteTargetId)
      setKeys((prev) => prev.filter((k) => k.id !== deleteTargetId))
      setSuccess('密钥已删除')
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败，请稍后重试')
    } finally {
      setDeleting(false)
      setDeleteTargetId(null)
    }
  }

  const handleCopied = () => {
    setSuccess('密钥已复制到剪贴板')
    setTimeout(() => setSuccess(null), 2000)
  }

  return (
    <BasePage
      title="API 密钥"
      contentStyle={{ padding: 16 }}
      header={
        <Button
          variant="contained"
          size="small"
          startIcon={<AddIcon />}
          onClick={() => setCreateOpen(true)}
          sx={{
            borderRadius: 1.5,
            bgcolor: '#4f46e5',
            '&:hover': { bgcolor: '#4338ca' },
            fontWeight: 600,
          }}
        >
          创建新密钥
        </Button>
      }
    >
      {success && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          onClose={() => setSuccess(null)}
        >
          {success}
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Usage Summary */}
      <UsageSummaryCard usage={usage} loading={loading} />

      {/* Keys Table */}
      <Paper
        elevation={0}
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            px: 2.5,
            py: 2,
            borderBottom: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Typography variant="subtitle1" fontWeight={700}>
            密钥列表
          </Typography>
          {!loading && (
            <Typography variant="body2" color="text.secondary">
              共 {keys.length} 个密钥
            </Typography>
          )}
        </Box>

        {loading ? (
          <Box sx={{ p: 2 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton
                key={`skeleton-${String(i)}`}
                height={52}
                sx={{ mb: 0.5 }}
              />
            ))}
          </Box>
        ) : keys.length === 0 ? (
          <Box
            sx={{
              py: 8,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1,
              color: 'text.secondary',
            }}
          >
            <Typography variant="body1">暂无密钥</Typography>
            <Typography variant="body2">
              点击右上角「创建新密钥」按钮开始使用
            </Typography>
          </Box>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell
                    sx={{
                      fontWeight: 700,
                      color: 'text.secondary',
                      fontSize: '0.78rem',
                    }}
                  >
                    名称
                  </TableCell>
                  <TableCell
                    sx={{
                      fontWeight: 700,
                      color: 'text.secondary',
                      fontSize: '0.78rem',
                    }}
                  >
                    密钥
                  </TableCell>
                  <TableCell
                    sx={{
                      fontWeight: 700,
                      color: 'text.secondary',
                      fontSize: '0.78rem',
                    }}
                  >
                    创建时间
                  </TableCell>
                  <TableCell
                    sx={{
                      fontWeight: 700,
                      color: 'text.secondary',
                      fontSize: '0.78rem',
                    }}
                  >
                    最后使用
                  </TableCell>
                  <TableCell
                    sx={{
                      fontWeight: 700,
                      color: 'text.secondary',
                      fontSize: '0.78rem',
                    }}
                  >
                    请求次数
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{
                      fontWeight: 700,
                      color: 'text.secondary',
                      fontSize: '0.78rem',
                    }}
                  >
                    操作
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {keys.map((key) => (
                  <KeyRow
                    key={key.id}
                    apiKey={key}
                    onDelete={(id) => setDeleteTargetId(id)}
                    onCopied={handleCopied}
                  />
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {/* Create Dialog */}
      <CreateKeyDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
        onError={(msg) => setError(msg)}
      />

      {/* Confirm Delete Dialog */}
      <ConfirmDeleteDialog
        open={Boolean(deleteTargetId)}
        onClose={() => setDeleteTargetId(null)}
        onConfirm={handleDeleteConfirm}
        deleting={deleting}
      />
    </BasePage>
  )
}

export default ApiKeysPage
