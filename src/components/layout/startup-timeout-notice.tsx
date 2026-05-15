import { Alert, Button, Snackbar } from '@mui/material'
import { useCallback, useState } from 'react'

export const STARTUP_TIMEOUT_NOTICE_KEY = 'xxlink:startup-timeout-notice'

type StartupTimeoutNoticeData = {
  message: string
  ts: number
}

const readStartupTimeoutNotice = (): StartupTimeoutNoticeData | null => {
  try {
    const raw = localStorage.getItem(STARTUP_TIMEOUT_NOTICE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StartupTimeoutNoticeData>
    if (!parsed.ts || Date.now() - parsed.ts > 60_000) {
      localStorage.removeItem(STARTUP_TIMEOUT_NOTICE_KEY)
      return null
    }
    return {
      message: parsed.message || 'App startup timed out',
      ts: parsed.ts,
    }
  } catch {
    return null
  }
}

export function StartupTimeoutNotice() {
  const [notice, setNotice] = useState(() => readStartupTimeoutNotice())

  const handleClose = useCallback(() => {
    try {
      localStorage.removeItem(STARTUP_TIMEOUT_NOTICE_KEY)
    } catch {
      /* ignore */
    }
    setNotice(null)
  }, [])

  return (
    <Snackbar
      open={Boolean(notice)}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
    >
      <Alert
        severity="warning"
        variant="filled"
        onClose={handleClose}
        action={
          <>
            <Button color="inherit" size="small" onClick={() => location.reload()}>
              Restart
            </Button>
            <Button color="inherit" size="small" onClick={handleClose}>
              Continue
            </Button>
          </>
        }
      >
        启动有点慢，可以继续使用或重启应用
      </Alert>
    </Snackbar>
  )
}
