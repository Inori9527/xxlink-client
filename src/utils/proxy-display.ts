const HIDDEN_PROXY_NAMES = new Set(['direct', 'reject', 'xxlink-desktop'])

export function isHiddenProxyName(name?: string | null) {
  if (typeof name !== 'string') return false
  return HIDDEN_PROXY_NAMES.has(name.trim().toLowerCase())
}

export function filterVisibleProxyItems<T extends { name?: string | null }>(
  items: Array<T | null | undefined>,
) {
  return items.filter(
    (item): item is T => Boolean(item) && !isHiddenProxyName(item?.name),
  )
}

export function expandVisibleProxyNames(
  name: string | null | undefined,
  records: Record<string, any> | undefined,
  seen = new Set<string>(),
): string[] {
  if (!name) return []

  const normalized = name.trim()
  if (!normalized || seen.has(normalized)) return []
  seen.add(normalized)

  const record = records?.[normalized]
  const childNames = Array.isArray(record?.all)
    ? (record.all as Array<string | { name?: string }>)
        .map((item) => (typeof item === 'string' ? item : item?.name))
        .filter((item): item is string => typeof item === 'string')
    : []

  if (isHiddenProxyName(normalized)) {
    return childNames.flatMap((childName) =>
      expandVisibleProxyNames(childName, records, seen),
    )
  }

  return [normalized]
}

export function formatVisibleProxyChain(chains: string[] | undefined | null) {
  return [...(chains || [])]
    .reverse()
    .filter((name) => !isHiddenProxyName(name))
    .join(' / ')
}

export function resolveVisibleProxyName(
  name: string | null | undefined,
  records: Record<string, any> | undefined,
  seen = new Set<string>(),
): string {
  if (!name) return ''

  const normalized = name.trim()
  if (!normalized || seen.has(normalized)) return ''
  seen.add(normalized)

  const record = records?.[normalized]
  const childNames = Array.isArray(record?.all)
    ? (record.all as Array<string | { name?: string }>)
        .map((item) => (typeof item === 'string' ? item : item?.name))
        .filter((item): item is string => typeof item === 'string')
    : []

  if (record?.now) {
    const resolved = resolveVisibleProxyName(record.now, records, seen)
    if (resolved) return resolved
  }

  for (const childName of childNames) {
    const resolved = resolveVisibleProxyName(childName, records, seen)
    if (resolved) return resolved
  }

  return isHiddenProxyName(normalized) ? '' : normalized
}
