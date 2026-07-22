import { Box, Button, LinearProgress, Link } from '@mui/material'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { useLockFn } from 'ahooks'
import type { Ref } from 'react'
import { useImperativeHandle, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import { BaseDialog, DialogRef } from '@/components/base'
import { useUpdate } from '@/hooks/use-update'
import { showNotice } from '@/services/notice-service'
import {
  classifyClientError,
  reportSafeClientFailure,
  toSafeClientErrorMessage,
} from '@/services/safe-client-error'
import { useSetUpdateState, useUpdateState } from '@/services/states'
import {
  getSafeUpdateLink,
  UPDATE_MARKDOWN_ALLOWED_ELEMENTS,
} from '@/services/update-content-policy'

export function UpdateViewer({
  ref,
  onDismiss,
}: {
  ref?: Ref<DialogRef>
  onDismiss?: () => void
}) {
  const { t } = useTranslation()

  const [open, setOpen] = useState(false)
  const updateState = useUpdateState()
  const setUpdateState = useSetUpdateState()

  const { updateInfo } = useUpdate()

  useImperativeHandle(ref, () => ({
    open: () => setOpen(true),
    close: () => setOpen(false),
  }))

  const markdownContent = useMemo(() => {
    if (!updateInfo?.body) {
      return '发现新版本。建议更新后再继续使用。'
    }
    return updateInfo?.body
  }, [updateInfo])

  const breakChangeFlag = useMemo(() => {
    if (!updateInfo?.body) {
      return false
    }
    return updateInfo?.body.toLowerCase().includes('break change')
  }, [updateInfo])

  const onUpdate = useLockFn(async () => {
    if (!updateInfo) return
    if (breakChangeFlag) {
      showNotice.error('settings.modals.update.messages.breakChangeError')
      return
    }
    if (updateState) return
    setUpdateState(true)

    try {
      await updateInfo.downloadAndInstall()
    } catch (err: unknown) {
      reportSafeClientFailure('update-install', err)
      showNotice.error(
        toSafeClientErrorMessage(classifyClientError(err).kind, t),
      )
    } finally {
      setUpdateState(false)
    }
  })

  return (
    <BaseDialog
      open={open}
      title={
        <Box display="flex" justifyContent="space-between">
          {t('settings.modals.update.title', {
            version: updateInfo?.version ?? '',
          })}
          <Box>
            <Button
              variant="contained"
              size="small"
              onClick={() => {
                openUrl('https://xxlink.net/download')
              }}
            >
              {t('settings.modals.update.actions.goToRelease')}
            </Button>
          </Box>
        </Box>
      }
      contentSx={{ minWidth: 360, maxWidth: 400, height: '50vh' }}
      okBtn={t('settings.modals.update.actions.update')}
      cancelBtn={t('shared.actions.cancel')}
      onClose={() => {
        setOpen(false)
        onDismiss?.()
      }}
      onCancel={() => {
        setOpen(false)
        onDismiss?.()
      }}
      onOk={onUpdate}
    >
      <Box sx={{ height: 'calc(100% - 10px)', overflow: 'auto' }}>
        <ReactMarkdown
          allowedElements={[...UPDATE_MARKDOWN_ALLOWED_ELEMENTS]}
          skipHtml
          components={{
            a: ({ children, href }) => {
              const safeHref = getSafeUpdateLink(href)
              if (!safeHref) return <span>{children}</span>

              return (
                <Link
                  component="button"
                  type="button"
                  onClick={() => void openUrl(safeHref)}
                >
                  {children}
                </Link>
              )
            },
          }}
        >
          {markdownContent}
        </ReactMarkdown>
      </Box>
      {updateState && (
        <LinearProgress variant="indeterminate" sx={{ marginTop: '5px' }} />
      )}
    </BaseDialog>
  )
}
