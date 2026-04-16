export interface UseIconCacheOptions {
  icon?: string | null
  cacheKey?: string
  enabled?: boolean
}

/**
 * Icon cache disabled — the `download_icon_cache` backend command was removed
 * along with other custom icon paths. Always returns an empty string so
 * consumers fall back to the raw icon URL.
 */
// eslint-disable-next-line @eslint-react/no-unnecessary-use-prefix
export const useIconCache = (_options: UseIconCacheOptions): string => ''
