import { invoke } from '@tauri-apps/api/core'

export type RuntimeProbeTarget = 'cloudflare' | 'gstatic'

export const runtimeNodeController = {
  probeDelay(proxyName: string, target: RuntimeProbeTarget, timeoutMs: number) {
    return invoke<number>('runtime_probe_node_delay', {
      proxyName,
      target,
      timeoutMs,
    })
  },
} as const
