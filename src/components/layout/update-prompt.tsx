import { useEffect, useRef } from 'react'

import { DialogRef } from '@/components/base'
import { useUpdate } from '@/hooks/use-update'
import { showNotice } from '@/services/notice-service'

import { UpdateViewer } from '../setting/mods/update-viewer'

const SEEN_VERSION_KEY = 'xxlink:update-prompted-version'

export const UpdatePrompt = () => {
  const viewerRef = useRef<DialogRef>(null)
  const { updateInfo } = useUpdate()

  useEffect(() => {
    const version = updateInfo?.version?.trim()
    if (!updateInfo?.available || !version) return

    try {
      if (localStorage.getItem(SEEN_VERSION_KEY) === version) {
        return
      }
      localStorage.setItem(SEEN_VERSION_KEY, version)
    } catch {
      /* ignore */
    }

    showNotice.info(`发现新版本 v${version}，可立即更新`)
    viewerRef.current?.open()
  }, [updateInfo?.available, updateInfo?.version])

  return <UpdateViewer ref={viewerRef} />
}
