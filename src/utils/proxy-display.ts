const SPEED_TOKEN = String.raw`\d+(?:\.\d+)?\s*(?:g|gb|gbps|m|mb|mbps)`
const SPEED_SUFFIX_RE = new RegExp(
  String.raw`\s*(?:[-|/·,])?\s*${SPEED_TOKEN}\b`,
  'gi',
)
const BRACKETED_SPEED_RE = new RegExp(
  String.raw`\s*(?:\(|（|\[)\s*${SPEED_TOKEN}\s*(?:\)|）|\])\s*`,
  'gi',
)
const PORT_SUFFIX_RE = /\s*[:：]\d{2,5}\b/g

const ALWAYS_HIDDEN_PROXY_NAMES = new Set(['xxlink-desktop'])
const INTERNAL_PROXY_NAMES = new Set(['direct', 'reject', 'proxy'])
const INTERNAL_PROXY_TYPES = new Set(['direct', 'reject', 'selector'])

type ProxyLike = {
  type?: string
}

export function isHiddenProxyName(name?: string | null): boolean {
  if (typeof name !== 'string') return true
  const normalized = name.trim().toLocaleLowerCase()
  return !normalized || ALWAYS_HIDDEN_PROXY_NAMES.has(normalized)
}

export function isHiddenProxyEntry(
  name?: string | null,
  proxy?: ProxyLike | null,
): boolean {
  if (isHiddenProxyName(name)) return true

  const normalized = name!.trim().toLocaleLowerCase()
  if (!INTERNAL_PROXY_NAMES.has(normalized)) return false

  const type = proxy?.type?.trim().toLocaleLowerCase()
  return !type || INTERNAL_PROXY_TYPES.has(type)
}

export function getProxyDisplayName(name: string): string {
  return name
    .replace(BRACKETED_SPEED_RE, ' ')
    .replace(SPEED_SUFFIX_RE, ' ')
    .replace(PORT_SUFFIX_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function getProxyDisplayKey(name: string): string {
  return getProxyDisplayName(name).toLocaleLowerCase()
}

export function dedupeProxiesByDisplayName<T extends { name: string }>(
  proxies: T[],
): T[] {
  const seen = new Set<string>()
  const result: T[] = []

  for (const proxy of proxies) {
    const key = getProxyDisplayKey(proxy.name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(proxy)
  }

  return result
}

export function filterVisibleProxyNames(names: string[]): string[] {
  return names.filter((name) => !isHiddenProxyEntry(name))
}
