import {
  Autocomplete,
  Box,
  Chip,
  InputAdornment,
  List,
  ListItem,
  ListItemText,
  styled,
  TextField,
  Typography,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  BaseDialog,
  BaseFieldset,
  BaseSplitChipEditor,
  DialogRef,
  Switch,
  TooltipIcon,
} from '@/components/base'
import { useSystemProxyState } from '@/hooks/use-system-proxy-state'
import { useVerge } from '@/hooks/use-verge'
import { useAppData } from '@/providers/app-data-context'
import { getNetworkInterfacesInfo, getSystemHostname } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { runtimeActionController } from '@/services/runtime-action-controller'
import type { RuntimePreferencesView } from '@/services/runtime-action-controller'
import {
  classifyClientError,
  reportSafeClientFailure,
  toSafeClientErrorMessage,
} from '@/services/safe-client-error'
import getSystem from '@/utils/get-system'

/** NO_PROXY validation */

// *., cdn*., *, etc.
const domain_subdomain_part = String.raw`(?:[a-z0-9\-\*]+\.|\*)*`
// .*, .cn, .moe, .co*, *
const domain_tld_part = String.raw`(?:\w{2,64}\*?|\*)`
// *epicgames*, *skk.moe, *.skk.moe, skk.*, sponsor.cdn.skk.moe, *.*, etc.
// also matches 192.168.*, 10.*, 127.0.0.*, etc. (partial ipv4)
const rDomainSimple = domain_subdomain_part + domain_tld_part

const ipv4_part = String.raw`\d{1,3}`

const ipv6_part = '(?:[a-fA-F0-9:])+'

const rLocal = `localhost|<local>|localdomain`

const getValidReg = (isWindows: boolean) => {
  // 127.0.0.1 (full ipv4)
  const rIPv4Unix = String.raw`(?:${ipv4_part}\.){3}${ipv4_part}(?:\/\d{1,2})?`
  const rIPv4Windows = String.raw`(?:${ipv4_part}\.){3}${ipv4_part}`

  const rIPv6Unix = String.raw`(?:${ipv6_part}:+)+${ipv6_part}(?:\/\d{1,3})?`
  const rIPv6Windows = String.raw`(?:${ipv6_part}:+)+${ipv6_part}`

  const rValidPart = `${rDomainSimple}|${
    isWindows ? rIPv4Windows : rIPv4Unix
  }|${isWindows ? rIPv6Windows : rIPv6Unix}|${rLocal}`
  const separator = isWindows ? ';' : ','
  const rValid = String.raw`^(${rValidPart})(?:${separator}\s?(${rValidPart}))*${separator}?$`

  return new RegExp(rValid)
}

const splitBypass = (value?: string) =>
  (value ?? '')
    .split(/[,\n;\r]+/)
    .map((item) => item.trim())
    .filter(Boolean)

const toSystemProxyForm = (preferences?: RuntimePreferencesView) => ({
  guard: preferences?.enable_proxy_guard ?? undefined,
  enable_bypass_check: preferences?.enable_bypass_check ?? true,
  bypass: preferences?.system_proxy_bypass ?? undefined,
  duration: preferences?.proxy_guard_duration ?? 10,
  use_default: preferences?.use_default_bypass ?? true,
  pac: preferences?.proxy_auto_config ?? undefined,
  proxy_host: preferences?.proxy_host ?? '127.0.0.1',
})

export const SysproxyViewer = forwardRef<DialogRef>((props, ref) => {
  const { t } = useTranslation()
  const systemName = getSystem()
  const isWindows = systemName === 'windows'
  const validReg = useMemo(() => getValidReg(isWindows), [isWindows])

  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [authoritativeLoaded, setAuthoritativeLoaded] = useState(false)
  const [authoritativePreferences, setAuthoritativePreferences] =
    useState<RuntimePreferencesView | null>(null)
  const refreshRequestRef = useRef(0)
  const mutationInFlightRef = useRef(false)
  const { verge, patchVerge, refreshVerge } = useVerge()
  const [hostOptions, setHostOptions] = useState<string[]>([])

  const { proxySettings } = useAppData()
  const {
    indicator: isProxyReallyEnabled,
    ready: isProxyStateReady,
    invalidateProxyState,
  } = useSystemProxyState()

  const activePreferences = authoritativePreferences ?? verge
  const {
    enable_system_proxy: enabled,
    proxy_auto_config,
    enable_proxy_guard,
    enable_bypass_check,
    use_default_bypass,
    system_proxy_bypass,
    proxy_guard_duration,
    proxy_host,
  } = activePreferences ?? {}

  const [value, setValue] = useState(() => toSystemProxyForm(verge))
  const busy = saving || refreshing

  const separator = useMemo(() => (isWindows ? ';' : ','), [isWindows])

  const defaultBypass = () => {
    if (isWindows) {
      return 'localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;<local>'
    }
    if (systemName === 'linux') {
      return 'localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,::1'
    }
    return '127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,localhost,*.local,*.crashlytics.com,<local>'
  }

  const prevMixedPortRef = useRef(proxySettings?.mixedPort)

  useEffect(() => {
    const mixedPort = proxySettings?.mixedPort
    if (!mixedPort || mixedPort === prevMixedPortRef.current) {
      return
    }

    prevMixedPortRef.current = mixedPort

    const updateProxy = async () => {
      try {
        await runtimeActionController.refreshSystemProxy()
        await invalidateProxyState()
      } catch (err) {
        reportSafeClientFailure('sysproxy-port-refresh', err)
        showNotice.error(
          toSafeClientErrorMessage(classifyClientError(err).kind, t),
        )
      }
    }

    updateProxy()
  }, [proxySettings?.mixedPort, value.pac, invalidateProxyState, t])

  const { systemProxyAddress } = useAppData()

  // 为当前状态计算系统代理地址
  const getSystemProxyAddress = useMemo(() => {
    if (!proxySettings) return '-'

    const isPacMode = value.pac ?? false

    if (isPacMode) {
      const host = value.proxy_host || '127.0.0.1'
      const port = verge?.verge_mixed_port || proxySettings.mixedPort || 7897
      return `${host}:${port}`
    } else {
      return systemProxyAddress
    }
  }, [
    value.pac,
    value.proxy_host,
    verge?.verge_mixed_port,
    proxySettings,
    systemProxyAddress,
  ])
  const getCurrentPacUrl = useMemo(() => {
    const host = value.proxy_host || '127.0.0.1'
    // 根据环境判断PAC端口
    const port = import.meta.env.DEV ? 11233 : 33331
    return `http://${host}:${port}/commands/pac`
  }, [value.proxy_host])

  const bypassError =
    value.enable_bypass_check &&
    !value.pac &&
    !value.use_default &&
    value.bypass
      ? !validReg.test(value.bypass)
      : false

  const closeDialog = () => {
    if (mutationInFlightRef.current) return
    refreshRequestRef.current += 1
    setRefreshing(false)
    setOpen(false)
  }

  useImperativeHandle(ref, () => ({
    open: () => {
      if (mutationInFlightRef.current) return
      const requestId = ++refreshRequestRef.current
      setOpen(true)
      setRefreshing(true)
      setAuthoritativeLoaded(false)
      setAuthoritativePreferences(null)
      setValue(toSystemProxyForm(verge))
      void refreshVerge()
        .then((preferences) => {
          if (requestId !== refreshRequestRef.current) return
          setAuthoritativePreferences(preferences)
          setValue(toSystemProxyForm(preferences))
          setAuthoritativeLoaded(true)
        })
        .catch((error: unknown) => {
          if (requestId !== refreshRequestRef.current) return
          setAuthoritativeLoaded(false)
          reportSafeClientFailure('sysproxy-settings-refresh', error)
          showNotice.error(
            toSafeClientErrorMessage(classifyClientError(error).kind, t),
          )
        })
        .finally(() => {
          if (requestId === refreshRequestRef.current) setRefreshing(false)
        })
      void fetchNetworkInterfaces()
    },
    close: closeDialog,
  }))

  // 获取网络接口和主机名
  const fetchNetworkInterfaces = async () => {
    try {
      // 获取系统网络接口信息
      const interfaces = await getNetworkInterfacesInfo()
      const ipAddresses: string[] = []

      // 从interfaces中提取IPv4和IPv6地址
      interfaces.forEach((iface) => {
        iface.addr.forEach((address) => {
          if (address.V4 && address.V4.ip) {
            ipAddresses.push(address.V4.ip)
          }
          if (address.V6 && address.V6.ip) {
            ipAddresses.push(address.V6.ip)
          }
        })
      })

      // 获取当前系统的主机名
      let hostname = ''
      try {
        hostname = await getSystemHostname()
      } catch (err) {
        reportSafeClientFailure('sysproxy-hostname', err)
      }

      // 构建选项列表
      const options = ['127.0.0.1', 'localhost']

      // 确保主机名添加到列表，即使它是空字符串也记录下来
      if (hostname) {
        // 如果主机名不是localhost或127.0.0.1，则添加它
        if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
          hostname = hostname + '.local'
          options.push(hostname)
        }
      }

      // 添加IP地址
      options.push(...ipAddresses)

      // 去重
      const uniqueOptions = Array.from(new Set(options))
      setHostOptions(uniqueOptions)
    } catch (error) {
      reportSafeClientFailure('sysproxy-network-interfaces', error)
      // 失败时至少提供基本选项
      setHostOptions(['127.0.0.1', 'localhost'])
    }
  }

  const onSave = useLockFn(async () => {
    if (
      mutationInFlightRef.current ||
      busy ||
      !authoritativeLoaded ||
      !authoritativePreferences
    ) {
      return
    }
    if (value.duration < 1) {
      showNotice.error('settings.modals.sysproxy.messages.durationTooShort')
      return
    }
    if (
      value.enable_bypass_check &&
      !value.pac &&
      !value.use_default &&
      value.bypass &&
      !validReg.test(value.bypass)
    ) {
      showNotice.error('settings.modals.sysproxy.messages.invalidBypass')
      return
    }

    // 修改验证规则，允许IP和主机名
    const ipv4Regex =
      /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/
    const ipv6Regex =
      /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/
    const hostnameRegex =
      /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])$/

    const unwrappedProxyHost =
      value.proxy_host.startsWith('[') && value.proxy_host.endsWith(']')
        ? value.proxy_host.slice(1, -1)
        : value.proxy_host
    const proxyHostIsIpv6 = ipv6Regex.test(unwrappedProxyHost)
    if (
      !ipv4Regex.test(value.proxy_host) &&
      !proxyHostIsIpv6 &&
      !hostnameRegex.test(value.proxy_host)
    ) {
      showNotice.error('settings.modals.sysproxy.messages.invalidProxyHost')
      return
    }

    const patch: Parameters<typeof patchVerge>[0] = {}

    if (value.guard !== enable_proxy_guard) {
      patch.enable_proxy_guard = value.guard
    }
    if (value.enable_bypass_check !== enable_bypass_check) {
      patch.enable_bypass_check = value.enable_bypass_check
    }
    if (value.duration !== proxy_guard_duration) {
      patch.proxy_guard_duration = value.duration
    }
    if (value.bypass !== system_proxy_bypass) {
      patch.system_proxy_bypass = value.bypass
    }
    if (value.pac !== proxy_auto_config) {
      patch.proxy_auto_config = value.pac
    }
    if (value.use_default !== use_default_bypass) {
      patch.use_default_bypass = value.use_default
    }

    const proxyHost = proxyHostIsIpv6
      ? `[${unwrappedProxyHost}]`
      : value.proxy_host

    if (proxyHost !== proxy_host) {
      patch.proxy_host = proxyHost
    }

    mutationInFlightRef.current = true
    setSaving(true)
    try {
      if (Object.keys(patch).length > 0) {
        await patchVerge(patch)
      }
      await invalidateProxyState()
      refreshRequestRef.current += 1
      setOpen(false)
    } catch (err) {
      setAuthoritativeLoaded(false)
      setAuthoritativePreferences(null)
      reportSafeClientFailure('sysproxy-save', err)
      showNotice.error(
        toSafeClientErrorMessage(classifyClientError(err).kind, t),
      )
    } finally {
      mutationInFlightRef.current = false
      setSaving(false)
    }
  })

  return (
    <BaseDialog
      open={open}
      title={t('settings.modals.sysproxy.title')}
      contentSx={{ width: 450, maxHeight: 565 }}
      okBtn={t('shared.actions.save')}
      cancelBtn={t('shared.actions.cancel')}
      onClose={closeDialog}
      onCancel={closeDialog}
      onOk={onSave}
      loading={saving}
      disableOk={busy || !authoritativeLoaded}
      disableCancel={saving}
    >
      <List
        inert={busy || !authoritativeLoaded ? true : undefined}
        aria-busy={busy}
      >
        <BaseFieldset
          label={t('settings.modals.sysproxy.fieldsets.currentStatus')}
          padding="15px 10px"
        >
          <FlexBox>
            <Typography className="label">
              {t('settings.modals.sysproxy.fields.enableStatus')}
            </Typography>
            <Typography className="value">
              {!isProxyStateReady
                ? '-'
                : isProxyReallyEnabled
                  ? t('shared.statuses.enabled')
                  : t('shared.statuses.disabled')}
            </Typography>
          </FlexBox>
          {!value.pac && (
            <FlexBox>
              <Typography className="label">
                {t('settings.modals.sysproxy.fields.serverAddr')}
              </Typography>
              <Typography className="value">{getSystemProxyAddress}</Typography>
            </FlexBox>
          )}
          {value.pac && (
            <FlexBox>
              <Typography className="label">
                {t('settings.modals.sysproxy.fields.pacUrl')}
              </Typography>
              <Typography className="value">
                {getCurrentPacUrl || '-'}
              </Typography>
            </FlexBox>
          )}
        </BaseFieldset>
        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText
            primary={t('settings.modals.sysproxy.fields.proxyHost')}
          />
          <Autocomplete
            size="small"
            sx={{ width: 150 }}
            options={hostOptions}
            value={value.proxy_host}
            freeSolo
            renderInput={(params) => (
              <TextField {...params} placeholder="127.0.0.1" size="small" />
            )}
            onChange={(_, newValue) => {
              setValue((v) => ({
                ...v,
                proxy_host: newValue || '127.0.0.1',
              }))
            }}
            onInputChange={(_, newInputValue) => {
              setValue((v) => ({
                ...v,
                proxy_host: newInputValue || '127.0.0.1',
              }))
            }}
          />
        </ListItem>
        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText
            primary={t('settings.modals.sysproxy.fields.usePacMode')}
          />
          <Switch
            edge="end"
            disabled={!enabled}
            checked={value.pac}
            onChange={(_, e) => setValue((v) => ({ ...v, pac: e }))}
          />
        </ListItem>

        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText
            primary={t('settings.modals.sysproxy.fields.proxyGuard')}
            sx={{ maxWidth: 'fit-content' }}
          />
          <TooltipIcon
            title={t('settings.modals.sysproxy.tooltips.proxyGuard')}
            sx={{ opacity: '0.7' }}
          />
          <Switch
            edge="end"
            disabled={!enabled}
            checked={value.guard}
            onChange={(_, e) => setValue((v) => ({ ...v, guard: e }))}
            sx={{ marginLeft: 'auto' }}
          />
        </ListItem>

        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText
            primary={t('settings.modals.sysproxy.fields.guardDuration')}
          />
          <TextField
            disabled={!enabled}
            size="small"
            value={value.duration}
            sx={{ width: 100 }}
            slotProps={{
              input: {
                endAdornment: <InputAdornment position="end">s</InputAdornment>,
              },
            }}
            onChange={(e) => {
              setValue((v) => ({
                ...v,
                duration: +e.target.value.replace(/\D/, ''),
              }))
            }}
          />
        </ListItem>
        {!value.pac && (
          <ListItem sx={{ padding: '5px 2px' }}>
            <ListItemText
              primary={t(
                'settings.modals.sysproxy.fields.alwaysUseDefaultBypass',
              )}
            />
            <Switch
              edge="end"
              disabled={!enabled}
              checked={value.use_default}
              onChange={(_, e) => {
                if (!e && !value.bypass) {
                  const nextBypass = defaultBypass()
                  setValue((v) => ({
                    ...v,
                    use_default: e,
                    // 当取消选择use_default且当前bypass为空时，填充默认值
                    bypass: nextBypass,
                  }))
                  return
                }
                setValue((v) => ({ ...v, use_default: e }))
              }}
            />
          </ListItem>
        )}

        {!value.pac && (
          <ListItem sx={{ padding: '5px 2px' }}>
            <ListItemText
              primary={t('settings.modals.sysproxy.fields.enableBypassCheck')}
            />
            <Switch
              edge="end"
              disabled={!enabled}
              checked={value.enable_bypass_check}
              onChange={(_, e) =>
                setValue((v) => ({ ...v, enable_bypass_check: e }))
              }
            />
          </ListItem>
        )}

        {!value.pac && !value.use_default && (
          <BaseSplitChipEditor
            value={value.bypass ?? ''}
            separator={separator}
            disabled={!enabled}
            error={bypassError}
            helperText={
              bypassError
                ? t('settings.modals.sysproxy.messages.invalidBypass')
                : undefined
            }
            placeholder="localhost"
            ariaLabel={t('settings.modals.sysproxy.fields.proxyBypass')}
            onChange={(nextValue) => {
              setValue((v) => ({ ...v, bypass: nextValue }))
            }}
            renderHeader={(modeToggle) => (
              <ListItem sx={{ padding: '5px 2px' }}>
                <ListItemText
                  primary={t('settings.modals.sysproxy.fields.proxyBypass')}
                />
                {modeToggle ? (
                  <Box sx={{ marginLeft: 'auto' }}>{modeToggle}</Box>
                ) : null}
              </ListItem>
            )}
          />
        )}

        {!value.pac && value.use_default && (
          <>
            <ListItemText
              primary={t('settings.modals.sysproxy.fields.bypass')}
            />
            <Box sx={{ padding: '0 2px 5px' }}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {splitBypass(defaultBypass()).map((item) => (
                  <Chip key={item} label={item} size="small" />
                ))}
              </Box>
            </Box>
          </>
        )}
      </List>
    </BaseDialog>
  )
})

const FlexBox = styled('div')`
  display: flex;
  margin-top: 4px;

  .label {
    flex: none;
    //width: 85px;
  }
`
