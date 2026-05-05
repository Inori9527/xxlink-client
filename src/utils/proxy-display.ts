const SPEED_SUFFIX_RE =
  /\s*(?:[-|/·,])?\s*(?:50|150|300)\s*(?:m|mb|mbps|Mbps)\b/gi
const BRACKETED_SPEED_RE =
  /\s*(?:\(|（|\[)\s*(?:50|150|300)\s*(?:m|mb|mbps|Mbps)\s*(?:\)|）|\])\s*/gi
const PORT_SUFFIX_RE = /\s*[:：]\d{2,5}\b/g

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
