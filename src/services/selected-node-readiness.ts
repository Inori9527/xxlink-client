import { delayProxyByName, type ProxyDelay } from 'tauri-plugin-mihomo-api'

export type SelectedNodeReadinessStatus =
  | 'disconnected'
  | 'connecting'
  | 'validating'
  | 'ready'
  | 'failed'

export type SelectedNodeReadinessResult =
  | {
      ok: true
      delays: number[]
      probeUrls: string[]
    }
  | {
      ok: false
      reason: 'missing-proxy' | 'unsafe-target' | 'timeout' | 'probe-error'
      delays: number[]
      probeUrls: string[]
    }

export type SelectedNodeReadinessProbe = (
  proxyName: string,
  url: string,
  timeoutMs: number,
) => Promise<ProxyDelay | number>

export const SELECTED_NODE_READINESS_TIMEOUT_MS = 6000

export const SELECTED_NODE_READINESS_PROBE_URLS = [
  'http://cp.cloudflare.com/generate_204',
  'https://www.gstatic.com/generate_204',
] as const

export const isSelectedNodeConnected = (
  runtimeConnected: boolean,
  readinessStatus: SelectedNodeReadinessStatus,
) => runtimeConnected && readinessStatus === 'ready'

export const shouldAutoSelectNode = ({
  runtimeConnected,
  groupName,
  nodeCount,
  currentSelectionValid,
}: {
  runtimeConnected: boolean
  groupName?: string
  nodeCount: number
  currentSelectionValid: boolean
}) =>
  !runtimeConnected &&
  Boolean(groupName) &&
  nodeCount > 0 &&
  !currentSelectionValid

const getDelayValue = (result: ProxyDelay | number) =>
  typeof result === 'number' ? result : result.delay

export const isReadinessProbeTargetSafe = (url: string) => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false
    }
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
    return host !== 'api.xxlink.net' && !host.endsWith('.xxlink.net')
  } catch {
    return false
  }
}

export const assertReadinessProbeTargetsSafe = (
  probeUrls: readonly string[] = SELECTED_NODE_READINESS_PROBE_URLS,
) => {
  if (!probeUrls.every(isReadinessProbeTargetSafe)) {
    throw new Error('Unsafe selected-node readiness probe target')
  }
}

const defaultProbe: SelectedNodeReadinessProbe = async (
  proxyName,
  url,
  timeoutMs,
) => delayProxyByName(proxyName, url, timeoutMs)

export const checkSelectedNodeReadiness = async ({
  proxyName,
  timeoutMs = SELECTED_NODE_READINESS_TIMEOUT_MS,
  probeUrls = SELECTED_NODE_READINESS_PROBE_URLS,
  probe = defaultProbe,
}: {
  proxyName: string
  timeoutMs?: number
  probeUrls?: readonly string[]
  probe?: SelectedNodeReadinessProbe
}): Promise<SelectedNodeReadinessResult> => {
  const trimmedProxyName = proxyName.trim()
  if (!trimmedProxyName) {
    return { ok: false, reason: 'missing-proxy', delays: [], probeUrls: [] }
  }

  try {
    assertReadinessProbeTargetsSafe(probeUrls)
  } catch {
    return {
      ok: false,
      reason: 'unsafe-target',
      delays: [],
      probeUrls: Array.from(probeUrls),
    }
  }

  const delays: number[] = []
  const usedProbeUrls = Array.from(probeUrls)

  try {
    let timedOut = false
    for (const url of usedProbeUrls) {
      const delay = getDelayValue(await probe(trimmedProxyName, url, timeoutMs))
      delays.push(delay)
      if (!Number.isFinite(delay) || delay <= 0 || delay >= timeoutMs) {
        timedOut = true
      }
    }
    if (timedOut) {
      return {
        ok: false,
        reason: 'timeout',
        delays,
        probeUrls: usedProbeUrls,
      }
    }
  } catch {
    return {
      ok: false,
      reason: 'probe-error',
      delays,
      probeUrls: usedProbeUrls,
    }
  }

  return { ok: true, delays, probeUrls: usedProbeUrls }
}
