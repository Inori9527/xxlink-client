import type {
  NodeView,
  PlanView,
  PublicBenefitView,
  SubscriptionView,
  UsageView,
} from '@/services/backend-controller'
import type {
  RuntimePreferencesView,
  RuntimeProxySettingsView,
  TunSettingsView,
} from '@/services/runtime-action-controller'

export type PreviewConnectionMode = 'system' | 'both' | 'smart'

export type PreviewPreferences = RuntimePreferencesView & {
  connect_mode: PreviewConnectionMode
}

export const PREVIEW_USER = {
  id: 'preview-user-001',
  email: 'preview@xxlink.net',
  role: 'USER',
} as const

export const PREVIEW_NODE_NAMES = [
  '东京-标准线路-01',
  '东京-标准线路-02',
  '东京-付费线路-01',
  '新加坡-付费线路-01',
  '洛杉矶-标准线路-01',
  '洛杉矶-标准线路-02',
  '香港-标准线路-01',
  '法兰克福-BGP专线-01',
  '都柏林-标准线路-01',
] as const

const PREVIEW_NODE_DELAYS: Record<string, number | null> = {
  '东京-标准线路-01': 45,
  '东京-标准线路-02': 78,
  '东京-付费线路-01': 120,
  '新加坡-付费线路-01': 168,
  '洛杉矶-标准线路-01': 215,
  '洛杉矶-标准线路-02': 260,
  '香港-标准线路-01': 92,
  '法兰克福-BGP专线-01': 320,
  '都柏林-标准线路-01': null,
}

const DAY_MS = 24 * 60 * 60 * 1000
const GIB = 1024 ** 3
const TIB = 1024 ** 4
const previewNow = Date.now()
const PREVIEW_START_AT = new Date(previewNow - 14 * DAY_MS).toISOString()
const PREVIEW_EXPIRE_AT = new Date(previewNow + 180 * DAY_MS).toISOString()
const PREVIEW_USED_BYTES = Math.round(14.1 * GIB)
const PREVIEW_LIMIT_BYTES = Math.round(2.93 * TIB)
const PREVIEW_REMAINING_BYTES = PREVIEW_LIMIT_BYTES - PREVIEW_USED_BYTES

export const previewState: {
  preferences: PreviewPreferences
  mode: PreviewConnectionMode
  connected: boolean
  selectedNode: string
  tunSettings: TunSettingsView
} = {
  preferences: {
    language: 'zh',
    theme_mode: 'dark',
    traffic_graph: true,
    enable_memory_usage: false,
    menu_icon: 'colorful',
    notice_position: 'top-right',
    collapse_navbar: true,
    enable_tun_mode: false,
    enable_system_proxy: false,
    enable_proxy_guard: false,
    enable_bypass_check: true,
    use_default_bypass: true,
    system_proxy_bypass: '',
    proxy_guard_duration: 30,
    proxy_auto_config: false,
    proxy_host: '127.0.0.1',
    proxy_host_valid: true,
    verge_mixed_port: 7897,
    auto_close_connection: false,
    auto_check_update: false,
    default_latency_timeout: 10_000,
    connect_mode: 'both',
  },
  mode: 'both',
  connected: false,
  selectedNode: PREVIEW_NODE_NAMES[0],
  tunSettings: {
    stack: 'mixed',
    device: 'xxlink-preview',
    autoRoute: true,
    autoRedirect: false,
    autoDetectInterface: true,
    dnsHijack: ['any:53'],
    routeExcludeAddress: ['127.0.0.0/8', '192.168.0.0/16'],
    strictRoute: false,
    mtu: 1500,
  },
}

export const PREVIEW_PLANS: PlanView[] = [
  {
    id: 'preview-plan-paid',
    name: 'Paid 2.93 TB',
    description: 'Browser preview fixture plan',
    price: 19.9,
    duration: 180,
    billingPeriod: 'month',
    trafficLimit: PREVIEW_LIMIT_BYTES,
    speedLimit: null,
    maxDevices: 5,
  },
  {
    id: 'preview-plan-standard',
    name: 'Standard 500 GB',
    description: 'Browser preview fallback plan',
    price: 9.9,
    duration: 30,
    billingPeriod: 'month',
    trafficLimit: 500 * GIB,
    speedLimit: 500,
    maxDevices: 3,
  },
]

export const PREVIEW_SUBSCRIPTION: SubscriptionView = {
  id: 'preview-subscription-paid',
  planId: PREVIEW_PLANS[0].id,
  trafficUsed: PREVIEW_USED_BYTES,
  startAt: PREVIEW_START_AT,
  expireAt: PREVIEW_EXPIRE_AT,
  status: 'ACTIVE',
  plan: PREVIEW_PLANS[0],
}

export const PREVIEW_USAGE: UsageView = {
  trafficUsed: String(PREVIEW_USED_BYTES),
  trafficLimit: String(PREVIEW_LIMIT_BYTES),
  baseTrafficLimit: String(PREVIEW_LIMIT_BYTES),
  bonusTrafficLimit: '0',
  trafficRemaining: String(PREVIEW_REMAINING_BYTES),
  percentUsed: (PREVIEW_USED_BYTES / PREVIEW_LIMIT_BYTES) * 100,
  plan: {
    id: PREVIEW_PLANS[0].id,
    name: PREVIEW_PLANS[0].name,
    duration: PREVIEW_PLANS[0].duration,
  },
  entitlement: {
    speedLimitMbps: 500,
    maxDevices: 5,
    accessTier: 'PAID',
    nodeTier: 'premium',
  },
  status: 'ACTIVE',
  expireAt: PREVIEW_EXPIRE_AT,
  startAt: PREVIEW_START_AT,
}

export const PREVIEW_PUBLIC_BENEFIT: PublicBenefitView = {
  visible: false,
  isTrial: false,
  hasPaidPlan: true,
  canClaim: false,
  emailVerified: true,
  claimBytes: '0',
  activeBonusBytes: '0',
  cooldownHours: 24,
  validHours: 72,
  lastClaimedAt: null,
  nextClaimAt: null,
  activeBonusExpiresAt: null,
  subscriptionCreated: true,
  bonusGranted: false,
}

export const PREVIEW_NODES: NodeView[] = PREVIEW_NODE_NAMES.map(
  (name, index) => ({
    id: `preview-node-${String(index + 1).padStart(2, '0')}`,
    name,
    protocol: name.includes('BGP')
      ? 'hysteria2'
      : name.includes('付费')
        ? 'vless'
        : 'shadowsocks',
    region: name.split('-')[0] ?? 'Preview',
    isActive: true,
  }),
)

type PreviewProxy = {
  name: string
  type: string
  alive: boolean
  history: Array<{ time: string; delay: number }>
  extra: Record<string, unknown>
  udp: boolean
  uot: boolean
  xudp: boolean
  tfo: boolean
  mptcp: boolean
  smux: boolean
  interface: string
  dialerProxy: string
  routingMark: number
  all?: string[]
  now?: string
}

const makeProxy = (name: string, delay: number | null): PreviewProxy => ({
  name,
  type: 'VLESS',
  alive: true,
  history: delay === null ? [] : [{ time: new Date().toISOString(), delay }],
  extra: {},
  udp: true,
  uot: false,
  xudp: true,
  tfo: false,
  mptcp: false,
  smux: false,
  interface: '',
  dialerProxy: '',
  routingMark: 0,
})

export const getPreviewNodeDelay = (name: string): number =>
  PREVIEW_NODE_DELAYS[name] ?? 90

export const getPreviewProxies = () => {
  const proxies: Record<string, PreviewProxy> = {}
  PREVIEW_NODE_NAMES.forEach((name) => {
    proxies[name] = makeProxy(name, PREVIEW_NODE_DELAYS[name] ?? null)
  })

  proxies.GLOBAL = {
    ...makeProxy('GLOBAL', 45),
    type: 'Selector',
    all: [...PREVIEW_NODE_NAMES],
    now: previewState.selectedNode,
  }
  proxies.DIRECT = { ...makeProxy('DIRECT', 1), type: 'Direct' }
  proxies.REJECT = { ...makeProxy('REJECT', 1), type: 'Reject' }

  return { proxies }
}

export const getPreviewPreferences = (): PreviewPreferences => ({
  ...previewState.preferences,
})

export const getPreviewProxySettings = (): RuntimeProxySettingsView => ({
  mixedPort: previewState.preferences.verge_mixed_port ?? 7897,
})

export const getPreviewSystemProxy = () => ({
  enable: previewState.preferences.enable_system_proxy,
  server: `127.0.0.1:${previewState.preferences.verge_mixed_port ?? 7897}`,
  bypass: previewState.preferences.system_proxy_bypass ?? '',
})

export const getPreviewAutoProxy = () => ({
  enable:
    previewState.preferences.enable_system_proxy === true &&
    previewState.preferences.proxy_auto_config === true,
  url: 'http://127.0.0.1:11233/commands/pac',
})
