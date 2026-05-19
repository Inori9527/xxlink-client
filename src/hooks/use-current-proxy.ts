import { useMemo } from 'react'

import { useAppData } from '@/providers/app-data-context'
import { isHiddenProxyEntry, isHiddenProxyName } from '@/utils/proxy-display'

// 定义代理组类型
interface ProxyGroup {
  name: string
  now: string
  all?: Array<string | { name?: string }>
}

const resolveVisibleProxyName = (
  records: Record<string, any> | undefined,
  name?: string,
  depth = 0,
): string => {
  if (!name || depth > 8) return ''
  const next = records?.[name]?.now
  const leaf =
    next && next !== name
      ? resolveVisibleProxyName(records, next, depth + 1)
      : name
  return isHiddenProxyEntry(leaf, records?.[leaf]) ? '' : leaf
}

// 获取当前代理节点信息的自定义Hook
export const useCurrentProxy = () => {
  // 从AppDataProvider获取数据
  const { proxies, clashConfig, refreshProxy } = useAppData()

  // 获取当前模式
  const currentMode = clashConfig?.mode?.toLowerCase() || 'rule'

  // 获取当前代理节点信息
  const currentProxyInfo = useMemo(() => {
    if (!proxies) return { currentProxy: null, primaryGroupName: null }

    const { global, groups, records } = proxies

    // 默认信息
    let primaryGroupName = 'GLOBAL'
    let currentName = global?.now

    // 在规则模式下，寻找主要代理组（通常是第一个或者名字包含特定关键词的组）
    if (currentMode === 'rule' && groups.length > 0) {
      // 查找主要的代理组（优先级：包含关键词 > 第一个非GLOBAL组）
      const primaryKeywords = [
        'auto',
        'select',
        'proxy',
        '节点选择',
        '自动选择',
      ]
      const visibleGroups = groups.filter(
        (group: ProxyGroup) =>
          !isHiddenProxyName(group.name) &&
          (group.all || []).some((item) => {
            const name = typeof item === 'string' ? item : item?.name
            return !isHiddenProxyEntry(name, records?.[name || ''])
          }),
      )
      const primaryGroup =
        visibleGroups.find((group: ProxyGroup) =>
          primaryKeywords.some((keyword) =>
            group.name.toLowerCase().includes(keyword.toLowerCase()),
          ),
        ) || visibleGroups.filter((g: ProxyGroup) => g.name !== 'GLOBAL')[0]

      if (primaryGroup) {
        primaryGroupName = primaryGroup.name
        currentName =
          resolveVisibleProxyName(records, primaryGroup.now) ||
          (primaryGroup.all || [])
            .map((item: string | { name?: string }) =>
              typeof item === 'string' ? item : item?.name || '',
            )
            .find((name: string) => !isHiddenProxyEntry(name, records?.[name]))
      }
    }

    // 如果找不到当前节点，返回null
    if (!currentName) return { currentProxy: null, primaryGroupName }

    // 获取完整的节点信息
    const visibleName =
      resolveVisibleProxyName(records, currentName) || currentName
    if (isHiddenProxyEntry(visibleName, records?.[visibleName]))
      return { currentProxy: null, primaryGroupName }

    const currentProxy = records[visibleName] || {
      name: visibleName,
      type: 'Unknown',
      udp: false,
      xudp: false,
      tfo: false,
      mptcp: false,
      smux: false,
      history: [],
    }

    return { currentProxy, primaryGroupName }
  }, [proxies, currentMode])

  return {
    currentProxy: currentProxyInfo.currentProxy,
    primaryGroupName: currentProxyInfo.primaryGroupName,
    mode: currentMode,
    refreshProxy,
  }
}
