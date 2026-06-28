export type NodeLatencyDisplay =
  | { kind: 'ms'; value: number }
  | { kind: 'timeout' }
  | { kind: 'unknown' }

export const getNodeLatencyDisplay = (
  delay: number | undefined,
  timeoutMs = 10000,
): NodeLatencyDisplay => {
  if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
    return { kind: 'unknown' }
  }
  if (delay === 0 || delay >= timeoutMs || delay > 1e5) {
    return { kind: 'timeout' }
  }
  return { kind: 'ms', value: Math.round(delay) }
}

export const formatNodeLatencyLabel = (
  delay: number | undefined,
  timeoutMs: number,
  labels: { timeout: string; unknown: string },
) => {
  const display = getNodeLatencyDisplay(delay, timeoutMs)
  if (display.kind === 'ms') return `${display.value} ms`
  if (display.kind === 'timeout') return labels.timeout
  return labels.unknown
}

export const getNodeLatencyChipColor = (
  delay: number | undefined,
  timeoutMs: number,
): 'success' | 'warning' | 'error' | undefined => {
  const display = getNodeLatencyDisplay(delay, timeoutMs)
  if (display.kind === 'unknown') return undefined
  if (display.kind === 'timeout') return 'error'
  if (display.value < 200) return 'success'
  if (display.value < 500) return 'warning'
  return 'error'
}
