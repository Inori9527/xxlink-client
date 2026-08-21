import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useVerge } from '@/hooks/use-verge'
import { useAppData } from '@/providers/app-data-context'
import delayManager from '@/services/delay'
import { showNotice } from '@/services/notice-service'
import { runtimeActionController } from '@/services/runtime-action-controller'
import type { SafeClientFailureScope } from '@/services/safe-client-error'
import {
  getProxyDisplayKey,
  getProxyDisplayName,
  isHiddenProxyEntry,
} from '@/utils/proxy-display'

export type ProxyEntry = {
  name: string
  type?: string
  now?: string
  all?: Array<ProxyEntry | string>
  history?: { time: string; delay: number }[]
}

export type DisplayNode = ProxyEntry & {
  displayName: string
  key: string
}

export type NodeRegion = {
  name: string
  nodes: DisplayNode[]
}

export type NodeSelectionSource = 'auto' | 'explicit'

export interface UseNodeCatalogOptions {
  selectionScope: SafeClientFailureScope
  onSelectionSuccess?: () => void | Promise<unknown>
  onSelectionError?: (error: unknown) => void
  autoSelect?: boolean
}

export interface NodeCatalog {
  currentNode: string
  currentNodeDisplay: string
  groupName: string
  latencyTimeout: number
  nodes: DisplayNode[]
  regions: NodeRegion[]
  selectedKey: string
  selectedNode: DisplayNode | undefined
  recommendedCandidate: { node: DisplayNode; delay: number } | null
  recommendedNode: DisplayNode | undefined
  recommendedDelay: number
  selectionSource: NodeSelectionSource | null
  testingDelay: boolean
  getNodeDelay: (node: DisplayNode) => number
  getDelayLabel: (delay: number) => string
  getDelayColor: (delay: number) => string
  selectNode: (node: DisplayNode, source?: NodeSelectionSource) => void
  testDelay: () => Promise<void>
}

export const REGION_FLAGS: Record<string, string> = {
  东京: '🇯🇵',
  新加坡: '🇸🇬',
  洛杉矶: '🇺🇸',
  香港: '🇭🇰',
  法兰克福: '🇩🇪',
  都柏林: '🇮🇪',
  伦敦: '🇬🇧',
  圣何塞: '🇺🇸',
  纽约: '🇺🇸',
}

export const getRegionFlag = (regionName: string) =>
  REGION_FLAGS[regionName] ?? '🌐'

export const getRegionName = (displayName: string) => {
  const separatorIndex = displayName.indexOf('-')
  return (
    separatorIndex === -1 ? displayName : displayName.slice(0, separatorIndex)
  ).trim()
}

export const getNodeRouteLabel = (displayName: string) => {
  const separatorIndex = displayName.indexOf('-')
  return separatorIndex === -1
    ? displayName
    : displayName.slice(separatorIndex + 1).trim() || displayName
}

export const groupNodes = (nodes: DisplayNode[]): NodeRegion[] => {
  const grouped = new Map<string, DisplayNode[]>()

  for (const node of nodes) {
    const regionName = getRegionName(node.displayName) || node.displayName
    const regionNodes = grouped.get(regionName) ?? []
    regionNodes.push(node)
    grouped.set(regionName, regionNodes)
  }

  return Array.from(grouped, ([name, regionNodes]) => ({
    name,
    nodes: regionNodes,
  }))
}

const getLatencyFromHistory = (node: DisplayNode): number | undefined => {
  const history = node.history
  if (!history || history.length === 0) return undefined
  const last = history[history.length - 1]
  if (!last || typeof last.delay !== 'number' || last.delay < 0) {
    return undefined
  }
  return last.delay
}

const resolveLeafProxyName = (
  records: Record<string, ProxyEntry> | undefined,
  name: string,
  depth = 0,
): string => {
  if (!records || !name || depth > 8) return name
  const next = records[name]?.now
  if (!next || next === name) return name
  return resolveLeafProxyName(records, next, depth + 1)
}

const resolveVisibleProxyName = (
  records: Record<string, ProxyEntry> | undefined,
  name: string,
): string => {
  const leaf = resolveLeafProxyName(records, name)
  if (!isHiddenProxyEntry(leaf, records?.[leaf])) return leaf
  return ''
}

export const useNodeCatalog = ({
  selectionScope,
  onSelectionSuccess,
  onSelectionError,
  autoSelect = true,
}: UseNodeCatalogOptions): NodeCatalog => {
  void selectionScope
  const { t } = useTranslation()
  const { verge } = useVerge()
  const { proxies, refreshProxy } = useAppData()
  const [delayRefreshTick, setDelayRefreshTick] = useState(0)
  const [testingDelay, setTestingDelay] = useState(false)
  const [selectionMeta, setSelectionMeta] = useState<{
    key: string
    source: NodeSelectionSource
  } | null>(null)
  const autoSelectAttemptRef = useRef<string | null>(null)

  const selectionSuccess = useCallback(() => {
    if (onSelectionSuccess) {
      void onSelectionSuccess()
      return
    }
    void refreshProxy()
  }, [onSelectionSuccess, refreshProxy])

  const { changeProxy } = useProxySelection({
    onSuccess: selectionSuccess,
    onError: onSelectionError,
    forceConnectionCleanup: true,
  })

  const globalGroup = proxies?.global as
    | {
        name?: string
        now?: string
        all?: Array<ProxyEntry | string>
      }
    | undefined
  const proxyRecords = proxies?.records as
    | Record<string, ProxyEntry>
    | undefined

  const currentNode = globalGroup?.now || ''
  const groupName = globalGroup?.name || ''
  const latencyTimeout = verge?.default_latency_timeout || 10000

  const nodes = useMemo<DisplayNode[]>(() => {
    const byKey = new Map<string, DisplayNode>()

    for (const item of globalGroup?.all ?? []) {
      const entry =
        typeof item === 'string'
          ? ({ name: item } as ProxyEntry)
          : (item as ProxyEntry)

      if (
        !entry ||
        typeof entry.name !== 'string' ||
        isHiddenProxyEntry(entry.name, proxyRecords?.[entry.name] ?? entry)
      ) {
        continue
      }

      const displayName = getProxyDisplayName(entry.name)
      const key = getProxyDisplayKey(entry.name)
      if (!displayName || !key) continue

      const node: DisplayNode = { ...entry, displayName, key }
      const existing = byKey.get(key)
      if (!existing || entry.name === currentNode) {
        byKey.set(key, node)
      }
    }

    return Array.from(byKey.values()).sort((a, b) => {
      const aAuto = a.displayName.toLowerCase() === 'auto'
      const bAuto = b.displayName.toLowerCase() === 'auto'
      if (aAuto && !bAuto) return -1
      if (bAuto && !aAuto) return 1
      return a.displayName.localeCompare(b.displayName)
    })
  }, [currentNode, globalGroup?.all, proxyRecords])

  const currentNodeDisplay = useMemo(() => {
    const match = nodes.find((entry) => entry.name === currentNode)
    if (match?.displayName) return match.displayName

    const visibleLeaf = resolveVisibleProxyName(proxyRecords, currentNode)
    return visibleLeaf ? getProxyDisplayName(visibleLeaf) : ''
  }, [currentNode, nodes, proxyRecords])

  const selectedNode = useMemo(() => {
    if (!currentNode && !currentNodeDisplay) return undefined
    const currentKey = currentNode ? getProxyDisplayKey(currentNode) : ''
    const displayKey = currentNodeDisplay
      ? getProxyDisplayKey(currentNodeDisplay)
      : ''

    return nodes.find(
      (node) =>
        node.name === currentNode ||
        (currentKey !== '' && node.key === currentKey) ||
        (displayKey !== '' && node.key === displayKey),
    )
  }, [currentNode, currentNodeDisplay, nodes])

  const selectedKey = selectedNode?.key ?? ''

  useEffect(() => {
    if (!groupName) return
    delayManager.setGroupListener(groupName, () =>
      setDelayRefreshTick((value) => value + 1),
    )
    return () => delayManager.removeGroupListener(groupName)
  }, [groupName])

  const getNodeDelay = useCallback(
    (node: DisplayNode) => {
      void delayRefreshTick
      const cachedDelay = groupName
        ? delayManager.getDelayUpdate(node.name, groupName)?.delay
        : undefined
      if (typeof cachedDelay === 'number') return cachedDelay

      return getLatencyFromHistory(node) ?? -1
    },
    [delayRefreshTick, groupName],
  )

  const getDelayLabel = useCallback(
    (delay: number) => {
      if (delay === -2) return t('layout.components.nodes.delay.testing')
      if (delay === -1) return t('layout.components.nodes.delay.notTested')
      if (delay === 0 || (delay >= latencyTimeout && delay <= 1e5)) {
        return t('layout.components.nodes.delay.timeout')
      }
      if (delay > 1e5) return t('layout.components.nodes.delay.failed')
      return t('layout.components.nodes.delay.ms', { value: delay })
    },
    [latencyTimeout, t],
  )

  const getDelayColor = useCallback(
    (delay: number) => {
      if (delay === -2) return 'primary.main'
      if (delay < 0) return 'text.secondary'
      if (delay === 0 || delay >= latencyTimeout) return 'error.main'
      if (delay < 100) return 'success.main'
      if (delay < 200) return 'warning.main'
      return 'error.main'
    },
    [latencyTimeout],
  )

  const recommendedCandidate = useMemo(
    () =>
      nodes.reduce<{ node: DisplayNode; delay: number } | null>(
        (best, node) => {
          const delay = getNodeDelay(node)
          if (!Number.isFinite(delay) || delay <= 0) return best
          if (!best || delay < best.delay) return { node, delay }
          return best
        },
        null,
      ),
    [getNodeDelay, nodes],
  )
  const recommendedNode = recommendedCandidate?.node ?? selectedNode
  const recommendedDelay =
    recommendedCandidate?.delay ??
    (selectedNode ? getNodeDelay(selectedNode) : -1)

  const selectNode = useCallback(
    (node: DisplayNode, source: NodeSelectionSource = 'explicit') => {
      if (!groupName || node.key === selectedKey || node.name === currentNode) {
        return
      }
      Promise.resolve().then(() => setSelectionMeta({ key: node.key, source }))
      changeProxy(groupName, node.name)
    },
    [changeProxy, currentNode, groupName, selectedKey],
  )

  useEffect(() => {
    autoSelectAttemptRef.current = null
  }, [groupName])

  useEffect(() => {
    if (!autoSelect || !groupName || selectedNode || !recommendedCandidate) {
      return
    }

    const attemptKey = `${groupName}:${recommendedCandidate.node.key}`
    if (autoSelectAttemptRef.current === attemptKey) return
    autoSelectAttemptRef.current = attemptKey
    selectNode(recommendedCandidate.node, 'auto')
  }, [autoSelect, groupName, recommendedCandidate, selectNode, selectedNode])

  const testDelay = useLockFn(async () => {
    if (!groupName || nodes.length === 0) return

    setTestingDelay(true)
    try {
      setDelayRefreshTick((value) => value + 1)
      await runtimeActionController.testNodeLatency({
        nodeNames: nodes.map((node) => node.name),
        groupName,
        timeoutMs: latencyTimeout,
      })
      setDelayRefreshTick((value) => value + 1)
      await refreshProxy()
    } catch {
      showNotice.error(t('layout.components.nodes.delay.failed'))
    } finally {
      setTestingDelay(false)
    }
  })

  return {
    currentNode,
    currentNodeDisplay,
    groupName,
    latencyTimeout,
    nodes,
    regions: groupNodes(nodes),
    selectedKey,
    selectedNode,
    recommendedCandidate,
    recommendedNode,
    recommendedDelay,
    selectionSource:
      selectedNode && selectionMeta?.key === selectedNode.key
        ? selectionMeta.source
        : null,
    testingDelay,
    getNodeDelay,
    getDelayLabel,
    getDelayColor,
    selectNode,
    testDelay,
  }
}
