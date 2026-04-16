import { Alert, Snackbar } from '@mui/material'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { delayGroup, healthcheckProxyProvider } from 'tauri-plugin-mihomo-api'

import { BaseEmpty } from '@/components/base'
import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useVerge } from '@/hooks/use-verge'
import { useAppData } from '@/providers/app-data-context'
import delayManager from '@/services/delay'
import { debugLog } from '@/utils/debug'

import { ScrollTopButton } from '../layout/scroll-top-button'

import {
  DEFAULT_HOVER_DELAY,
  ProxyGroupNavigator,
} from './proxy-group-navigator'
import { ProxyRender } from './proxy-render'
import { useRenderList } from './use-render-list'

interface Props {
  mode: string
}

export const ProxyGroups = (props: Props) => {
  const { mode } = props
  const [duplicateWarning, setDuplicateWarning] = useState<{
    open: boolean
    message: string
  }>({ open: false, message: '' })

  const { verge } = useVerge()
  const { proxies: proxiesData } = useAppData()
  void proxiesData

  const { renderList, onProxies, onHeadState } = useRenderList(mode)

  const getGroupHeadState = useCallback(
    (groupName: string) => {
      const headItem = renderList.find(
        (item) => item.type === 1 && item.group?.name === groupName,
      )
      return headItem?.headState
    },
    [renderList],
  )

  // 统代理选择
  const { handleProxyGroupChange } = useProxySelection({
    onSuccess: () => {
      onProxies()
    },
    onError: (error) => {
      console.error('代理切换失败', error)
      onProxies()
    },
  })

  const timeout = verge?.default_latency_timeout || 10000

  const parentRef = useRef<HTMLDivElement>(null)
  const scrollPositionRef = useRef<Record<string, number>>({})
  const [showScrollTop, setShowScrollTop] = useState(false)

  const virtualizer = useVirtualizer({
    count: renderList.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 15,
    getItemKey: (index) => renderList[index]?.key ?? index,
  })

  // 从 localStorage 恢复滚动位置
  useEffect(() => {
    if (renderList.length === 0) return

    let restoreTimer: ReturnType<typeof setTimeout> | null = null

    try {
      const savedPositions = localStorage.getItem('proxy-scroll-positions')
      if (savedPositions) {
        const positions = JSON.parse(savedPositions)
        scrollPositionRef.current = positions
        const savedPosition = positions[mode]

        if (savedPosition !== undefined) {
          restoreTimer = setTimeout(() => {
            if (parentRef.current) {
              parentRef.current.scrollTop = savedPosition
            }
          }, 100)
        }
      }
    } catch (e) {
      console.error('Error restoring scroll position:', e)
    }

    return () => {
      if (restoreTimer) {
        clearTimeout(restoreTimer)
      }
    }
  }, [mode, renderList.length])

  // 改为使用节流函数保存滚动位置
  const saveScrollPosition = useCallback(
    (scrollTop: number) => {
      try {
        scrollPositionRef.current[mode] = scrollTop
        localStorage.setItem(
          'proxy-scroll-positions',
          JSON.stringify(scrollPositionRef.current),
        )
      } catch (e) {
        console.error('Error saving scroll position:', e)
      }
    },
    [mode],
  )

  // 使用改进的滚动处理
  const handleScroll = useMemo(
    () =>
      throttle((event: Event) => {
        const target = event.target as HTMLElement | null
        const scrollTop = target?.scrollTop ?? 0
        setShowScrollTop(scrollTop > 100)
        // 使用稳定的节流来保存位置，而不是setTimeout
        saveScrollPosition(scrollTop)
      }, 500),
    [saveScrollPosition],
  )

  // 添加和清理滚动事件监听器
  useEffect(() => {
    const node = parentRef.current
    if (!node) return

    const listener = handleScroll as EventListener
    const options: AddEventListenerOptions = { passive: true }

    node.addEventListener('scroll', listener, options)

    return () => {
      node.removeEventListener('scroll', listener, options)
    }
  }, [handleScroll])

  // 滚动到顶部
  const scrollToTop = useCallback(() => {
    parentRef.current?.scrollTo?.({
      top: 0,
      behavior: 'smooth',
    })
    saveScrollPosition(0)
  }, [saveScrollPosition])

  const handleCloseDuplicateWarning = useCallback(() => {
    setDuplicateWarning({ open: false, message: '' })
  }, [])

  const handleChangeProxy = useCallback(
    (group: IProxyGroupItem, proxy: IProxyItem) => {
      if (!['Selector', 'URLTest', 'Fallback'].includes(group.type)) return
      handleProxyGroupChange(group, proxy)
    },
    [handleProxyGroupChange],
  )

  // 测全部延迟
  const handleCheckAll = useLockFn(async (groupName: string) => {
    debugLog(`[ProxyGroups] 开始测试所有延迟，组: ${groupName}`)

    const proxies = renderList
      .filter(
        (e) => e.group?.name === groupName && (e.type === 2 || e.type === 4),
      )
      .flatMap((e) => e.proxyCol || e.proxy!)
      .filter(Boolean)

    debugLog(`[ProxyGroups] 找到代理数量: ${proxies.length}`)

    const providers = new Set(proxies.map((p) => p!.provider!).filter(Boolean))

    if (providers.size) {
      debugLog(`[ProxyGroups] 发现提供者，数量: ${providers.size}`)
      Promise.allSettled(
        [...providers].map((p) => healthcheckProxyProvider(p)),
      ).then(() => {
        debugLog(`[ProxyGroups] 提供者健康检查完成`)
        onProxies()
      })
    }

    const names = proxies.filter((p) => !p!.provider).map((p) => p!.name)
    debugLog(`[ProxyGroups] 过滤后需要测试的代理数量: ${names.length}`)

    const url = delayManager.getUrl(groupName)
    debugLog(`[ProxyGroups] 测试URL: ${url}, 超时: ${timeout}ms`)

    try {
      await Promise.race([
        delayManager.checkListDelay(names, groupName, timeout),
        delayGroup(groupName, url, timeout).then((result) => {
          debugLog(
            `[ProxyGroups] getGroupProxyDelays返回结果数量:`,
            Object.keys(result || {}).length,
          )
        }),
      ])
      debugLog(`[ProxyGroups] 延迟测试完成，组: ${groupName}`)
    } catch (error) {
      console.error(`[ProxyGroups] 延迟测试出错，组: ${groupName}`, error)
    } finally {
      const headState = getGroupHeadState(groupName)
      if (headState?.sortType === 1) {
        onHeadState(groupName, { sortType: headState.sortType })
      }
      onProxies()
    }
  })

  // 滚到对应的节点
  const handleLocation = (group: IProxyGroupItem) => {
    if (!group) return
    const { name, now } = group

    const index = renderList.findIndex(
      (e) =>
        e.group?.name === name &&
        ((e.type === 2 && e.proxy?.name === now) ||
          (e.type === 4 && e.proxyCol?.some((p) => p.name === now))),
    )

    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' })
    }
  }

  // 定位到指定的代理组
  const handleGroupLocationByName = useCallback(
    (groupName: string) => {
      const index = renderList.findIndex(
        (item) => item.type === 0 && item.group?.name === groupName,
      )

      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: 'start', behavior: 'smooth' })
      }
    },
    [renderList, virtualizer],
  )

  const proxyGroupNames = useMemo(() => {
    const names = renderList
      .filter((item) => item.type === 0 && item.group?.name)
      .map((item) => item.group!.name)
    return Array.from(new Set(names))
  }, [renderList])

  if (mode === 'direct') {
    return <BaseEmpty textKey="proxies.page.messages.directMode" />
  }

  return (
    <div
      style={{ position: 'relative', height: '100%', willChange: 'transform' }}
    >
      {/* 代理组导航栏 */}
      {mode === 'rule' && (
        <ProxyGroupNavigator
          proxyGroupNames={proxyGroupNames}
          onGroupLocation={handleGroupLocationByName}
          enableHoverJump={verge?.enable_hover_jump_navigator ?? true}
          hoverDelay={verge?.hover_jump_navigator_delay ?? DEFAULT_HOVER_DELAY}
        />
      )}

      <div
        ref={parentRef}
        style={{ height: 'calc(100% - 14px)', overflow: 'auto' }}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <ProxyRender
                item={renderList[virtualItem.index]}
                indent={mode === 'rule' || mode === 'script'}
                onLocation={handleLocation}
                onCheckAll={handleCheckAll}
                onHeadState={onHeadState}
                onChangeProxy={handleChangeProxy}
              />
            </div>
          ))}
          <div style={{ height: 8 }} />
        </div>
      </div>
      <ScrollTopButton show={showScrollTop} onClick={scrollToTop} />

      <Snackbar
        open={duplicateWarning.open}
        autoHideDuration={3000}
        onClose={handleCloseDuplicateWarning}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert
          onClose={handleCloseDuplicateWarning}
          severity="warning"
          variant="filled"
        >
          {duplicateWarning.message}
        </Alert>
      </Snackbar>
    </div>
  )
}

// 替换简单防抖函数为更优的节流函数
function throttle<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let previous = 0

  return function (...args: Parameters<T>) {
    const now = Date.now()
    const remaining = wait - (now - previous)

    if (remaining <= 0 || remaining > wait) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      previous = now
      func(...args)
    } else if (!timer) {
      timer = setTimeout(() => {
        previous = Date.now()
        timer = null
        func(...args)
      }, remaining)
    }
  }
}
