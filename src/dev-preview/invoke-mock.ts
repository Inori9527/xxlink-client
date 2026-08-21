import { authStore, type AuthUser } from '@/services/auth-store'
import { queryClient } from '@/services/query-client'

import {
  getPreviewAutoProxy,
  getPreviewNodeDelay,
  getPreviewPreferences,
  getPreviewProxies,
  getPreviewProxySettings,
  getPreviewSystemProxy,
  PREVIEW_NODES,
  PREVIEW_PLANS,
  PREVIEW_PUBLIC_BENEFIT,
  PREVIEW_SUBSCRIPTION,
  PREVIEW_USAGE,
  PREVIEW_USER,
  previewState,
  type PreviewConnectionMode,
} from './preview-state'

const previewStartedAt = Date.now()

const ensurePreviewAuth = () => {
  const currentUser = authStore.getState().user
  if (currentUser?.id === PREVIEW_USER.id) return
  authStore.setAuthenticatedUser(PREVIEW_USER as AuthUser)
}

const currentSubjectId = () => authStore.getState().user?.id ?? PREVIEW_USER.id

const subjectReply = <T>(data: T) => ({
  subjectId: currentSubjectId(),
  data,
})

const publishRuntimeState = () => {
  queryClient.setQueryData(['getVergeConfig'], getPreviewPreferences())
  queryClient.setQueryData(['getSystemProxy'], getPreviewSystemProxy())
  queryClient.setQueryData(['getAutotemProxy'], getPreviewAutoProxy())
  queryClient.setQueryData(['getProxies'], getPreviewProxies())
}

const setConnectionState = (mode: PreviewConnectionMode, enabled: boolean) => {
  previewState.mode = mode
  previewState.connected = enabled
  previewState.preferences = {
    ...previewState.preferences,
    connect_mode: mode,
    enable_tun_mode: enabled && mode !== 'system',
    enable_system_proxy: enabled,
  }
  publishRuntimeState()
}

const recomputeConnectionState = () => {
  const { enable_system_proxy, enable_tun_mode } = previewState.preferences
  previewState.connected =
    previewState.mode === 'system'
      ? enable_system_proxy
      : enable_tun_mode === true && enable_system_proxy === true
  publishRuntimeState()
}

const emptyLogSummary = (source: 'runtime' | 'clash') => ({
  source,
  componentCount: 0,
  totalCount: 0,
  inspectedCount: 0,
  omittedCount: 0,
  levels: { debug: 0, info: 0, warn: 0, error: 0, unknown: 0 },
  categories: {
    'auth-session': 0,
    network: 0,
    'profile-sync': 0,
    timeout: 0,
    storage: 0,
    'structured-or-sensitive': 0,
    oversized: 0,
    other: 0,
    unrecognized: 0,
  },
})

const unknownInvokeFallback = (command: string) => {
  // Preview-only diagnostic required for newly introduced IPC call sites.
  globalThis.console.warn(
    `[xxlink browser preview] Unmocked invoke command: ${command}`,
  )

  if (
    command.includes('list') ||
    command.includes('profiles') ||
    command.includes('nodes')
  ) {
    return []
  }
  if (command.startsWith('is_') || command.startsWith('app_is_')) return false
  if (command.startsWith('get_') && command.includes('count')) return 0
  return null
}

/**
 * Browser-preview replacement for @tauri-apps/api/core.
 * Keep this dispatcher deliberately local to the preview alias; production
 * builds continue to resolve the real Tauri invoke implementation.
 */
export async function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  switch (command) {
    case 'secure_session_recover_pending_logout':
      ensurePreviewAuth()
      return { pending: false, cleaned: false } as T
    case 'secure_session_probe':
      return (
        args?.subjectId === currentSubjectId()
          ? 'operational'
          : 'subject_mismatch'
      ) as T
    case 'secure_session_migrate_legacy':
    case 'secure_session_logout':
      return undefined as T
    case 'secure_session_login':
      return PREVIEW_USER as T

    case 'backend_get_plans':
      return subjectReply(PREVIEW_PLANS) as T
    case 'backend_get_subscription':
      return subjectReply(PREVIEW_SUBSCRIPTION) as T
    case 'backend_get_usage':
      return subjectReply(PREVIEW_USAGE) as T
    case 'backend_get_public_benefit':
    case 'backend_claim_public_benefit':
      return subjectReply(PREVIEW_PUBLIC_BENEFIT) as T
    case 'backend_get_nodes':
      return subjectReply(PREVIEW_NODES) as T
    case 'backend_get_user_profile':
      return subjectReply({
        id: PREVIEW_USER.id,
        email: PREVIEW_USER.email,
        role: PREVIEW_USER.role,
      }) as T
    case 'backend_redeem_promo':
      return subjectReply({
        code: String(args?.code ?? 'PREVIEW'),
        type: 'TRAFFIC',
        bonusBytes: '0',
        message: 'Browser preview promo fixture',
        subscriptionCreated: false,
      }) as T
    case 'backend_report_traffic':
      return subjectReply({
        trafficUsed: PREVIEW_USAGE.trafficUsed,
        trafficLimit: PREVIEW_USAGE.trafficLimit,
        remaining: PREVIEW_USAGE.trafficRemaining,
      }) as T
    case 'managed_subscription_sync':
      return subjectReply(undefined) as T

    case 'runtime_get_preferences':
      return getPreviewPreferences() as T
    case 'runtime_update_preferences': {
      const patch = (args?.preferences ?? {}) as Partial<
        typeof previewState.preferences
      >
      previewState.preferences = {
        ...previewState.preferences,
        ...patch,
      }
      recomputeConnectionState()
      return undefined as T
    }
    case 'runtime_set_connection_mode':
      previewState.mode = (args?.mode as PreviewConnectionMode) ?? 'both'
      previewState.preferences = {
        ...previewState.preferences,
        connect_mode: previewState.mode,
      }
      publishRuntimeState()
      return undefined as T
    case 'runtime_set_connection_enabled':
      setConnectionState(
        (args?.mode as PreviewConnectionMode) ?? previewState.mode,
        args?.enabled === true,
      )
      return undefined as T
    case 'runtime_set_tun_enabled':
      previewState.preferences = {
        ...previewState.preferences,
        enable_tun_mode: args?.enabled === true,
      }
      recomputeConnectionState()
      return undefined as T
    case 'runtime_set_system_proxy_enabled':
      previewState.preferences = {
        ...previewState.preferences,
        enable_system_proxy: args?.enabled === true,
      }
      recomputeConnectionState()
      return undefined as T
    case 'runtime_disable_tun_if_unavailable':
      return false as T
    case 'runtime_get_proxy_settings':
      return getPreviewProxySettings() as T
    case 'runtime_get_tun_settings':
      return { ...previewState.tunSettings } as T
    case 'runtime_update_tun_settings':
      previewState.tunSettings = {
        ...previewState.tunSettings,
        ...((args?.settings ?? {}) as Partial<typeof previewState.tunSettings>),
      }
      return { ...previewState.tunSettings } as T
    case 'runtime_refresh_system_proxy':
      publishRuntimeState()
      return undefined as T
    case 'runtime_install_service_and_restart_core':
    case 'runtime_uninstall_service_and_restart_core':
      return undefined as T
    case 'runtime_select_node': {
      const proxyName = String(args?.proxyName ?? '')
      if (PREVIEW_NODES.some((node) => node.name === proxyName)) {
        previewState.selectedNode = proxyName
        queryClient.setQueryData(['getProxies'], getPreviewProxies())
      }
      return undefined as T
    }
    case 'runtime_probe_node_delay': {
      const proxyName = String(args?.proxyName ?? '')
      const target = args?.target === 'gstatic' ? 12 : 0
      return (getPreviewNodeDelay(proxyName) + target) as T
    }
    case 'runtime_check_update':
      return null as T
    case 'runtime_install_update':
      return undefined as T

    case 'get_sys_proxy':
      return getPreviewSystemProxy() as T
    case 'get_auto_proxy':
      return getPreviewAutoProxy() as T
    case 'get_system_info':
      return 'Windows browser preview' as T
    case 'get_system_hostname':
      return 'XXLINK-PREVIEW' as T
    case 'get_network_interfaces_info':
      return [
        {
          name: 'Browser preview adapter',
          addr: [{ V4: { ip: '127.0.0.1' } }],
          index: 1,
        },
      ] as T
    case 'get_running_mode':
      return 'Sidecar' as T
    case 'get_app_uptime':
      return Math.max(0, Date.now() - previewStartedAt) as T
    case 'get_service_availability':
      return 'ready' as T
    case 'app_is_admin':
      return true as T
    case 'enhance_profiles':
      return undefined as T

    case 'update_ui_stage':
    case 'notify_ui_ready':
    case 'runtime_write_diagnostics_bundle':
      return undefined as T
    case 'runtime_get_diagnostics_log_summaries':
      return {
        runtime: emptyLogSummary('runtime'),
        clash: emptyLogSummary('clash'),
      } as T
    default:
      return unknownInvokeFallback(command) as T
  }
}
