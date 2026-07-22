export const UPDATE_MARKDOWN_ALLOWED_ELEMENTS = [
  'p',
  'h1',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'code',
  'pre',
  'blockquote',
  'a',
  'br',
  'hr',
] as const

export function getSafeUpdateLink(href: string | undefined): string | null {
  if (!href || href.length > 2048) return null

  try {
    const url = new URL(href)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    ) {
      return null
    }

    const hostname = url.hostname.toLowerCase()
    const isFirstParty = [
      'xxlink.net',
      'www.xxlink.net',
      'api.xxlink.net',
    ].includes(hostname)
    const isOfficialRepository =
      hostname === 'github.com' &&
      /^\/inori9527\/xxlink-client(?:\/|$)/i.test(url.pathname)

    if (!isFirstParty && !isOfficialRepository) return null
    return url.toString()
  } catch {
    return null
  }
}
