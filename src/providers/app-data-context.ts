import { createContext, use } from 'react'

import type { RuntimeProxySettingsView } from '@/services/runtime-action-controller'

export interface AppDataContextType {
  proxies: any
  proxySettings?: RuntimeProxySettingsView
  sysproxy: any
  runningMode?: string
  uptime: number
  systemProxyAddress: string

  refreshProxy: () => Promise<any>
  refreshProxySettings: () => Promise<any>
  refreshSysproxy: () => Promise<any>
  refreshAll: () => Promise<any>
}

export interface ConnectionWithSpeed extends IConnectionsItem {
  curUpload: number
  curDownload: number
}

export interface ConnectionSpeedData {
  id: string
  upload: number
  download: number
  timestamp: number
}

export const AppDataContext = createContext<AppDataContextType | null>(null)

export const useAppData = () => {
  const context = use(AppDataContext)

  if (!context) {
    throw new Error('useAppData must be used within AppDataProvider')
  }

  return context
}
