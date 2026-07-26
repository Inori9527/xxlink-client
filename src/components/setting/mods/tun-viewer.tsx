import {
  Box,
  Button,
  List,
  ListItem,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { useLockFn } from 'ahooks'
import type { Ref } from 'react'
import { useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  BaseDialog,
  BaseSplitChipEditor,
  TooltipIcon,
  DialogRef,
  Switch,
} from '@/components/base'
import { enhanceProfiles } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import {
  runtimeActionController,
  TunSettingsView,
} from '@/services/runtime-action-controller'
import {
  classifyClientError,
  reportSafeClientFailure,
  toSafeClientErrorMessage,
} from '@/services/safe-client-error'
import getSystem from '@/utils/get-system'
import { areValidIpCidrs } from '@/utils/network'

import { StackModeSwitch } from './stack-mode-switch'

const OS = getSystem()

type TunSettingsForm = Omit<TunSettingsView, 'routeExcludeAddress'> & {
  routeExcludeAddress: string
}

const toTunSettingsForm = (
  settings: TunSettingsView | undefined,
): TunSettingsForm => {
  const nextAutoRoute = settings?.autoRoute ?? true
  const rawAutoRedirect = settings?.autoRedirect ?? false
  return {
    stack: settings?.stack ?? 'gvisor',
    device: settings?.device ?? (OS === 'macos' ? 'utun1024' : 'Mihomo'),
    autoRoute: nextAutoRoute,
    routeExcludeAddress: (settings?.routeExcludeAddress ?? []).join(','),
    autoRedirect:
      OS === 'linux' ? (nextAutoRoute ? rawAutoRedirect : false) : false,
    autoDetectInterface: settings?.autoDetectInterface ?? true,
    dnsHijack: settings?.dnsHijack ?? ['any:53'],
    strictRoute: settings?.strictRoute ?? false,
    mtu: settings?.mtu ?? 1500,
  }
}

const splitRouteExcludeAddress = (value: string) =>
  value
    .split(/[,\n;\r]+/)
    .map((item) => item.trim())
    .filter(Boolean)

const defaultTunSettings = (): TunSettingsView => ({
  stack: 'gvisor',
  device: OS === 'macos' ? 'utun1024' : 'Mihomo',
  autoRoute: true,
  autoRedirect: false,
  autoDetectInterface: true,
  dnsHijack: ['any:53'],
  routeExcludeAddress: [],
  strictRoute: false,
  mtu: 1500,
})

export function TunViewer({ ref }: { ref?: Ref<DialogRef> }) {
  const { t } = useTranslation()

  const { data: tunSettings, refetch: refreshTunSettings } = useQuery({
    queryKey: ['runtimeTunSettings'],
    queryFn: runtimeActionController.getTunSettings,
    enabled: false,
  })

  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [authoritativeLoaded, setAuthoritativeLoaded] = useState(false)
  const refreshRequestRef = useRef(0)
  const mutationInFlightRef = useRef(false)
  const [values, setValues] = useState<TunSettingsForm>({
    stack: 'mixed',
    device: OS === 'macos' ? 'utun1024' : 'Mihomo',
    autoRoute: true,
    routeExcludeAddress: '',
    autoRedirect: false,
    autoDetectInterface: true,
    dnsHijack: ['any:53'],
    strictRoute: false,
    mtu: 1500,
  })

  const routeExcludeAddressItems = splitRouteExcludeAddress(
    values.routeExcludeAddress,
  )
  const routeExcludeAddressError =
    routeExcludeAddressItems.length > 0 &&
    !areValidIpCidrs(routeExcludeAddressItems)
  const routeExcludeAddressHelperText = routeExcludeAddressError
    ? t('settings.modals.tun.messages.invalidRouteExcludeAddress')
    : t('settings.modals.tun.messages.routeExcludeAddressHint')
  const busy = refreshing || mutating

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
      setValues(toTunSettingsForm(tunSettings))
      void refreshTunSettings()
        .then(({ data, error }) => {
          if (requestId !== refreshRequestRef.current) return
          if (data) {
            setValues(toTunSettingsForm(data))
            setAuthoritativeLoaded(true)
          }
          if (error || !data) {
            const failure = error ?? new Error('tun_settings_unavailable')
            reportSafeClientFailure('tun-settings-refresh', failure)
            showNotice.error(
              toSafeClientErrorMessage(classifyClientError(failure).kind, t),
            )
          }
        })
        .catch((error: unknown) => {
          if (requestId === refreshRequestRef.current) {
            reportSafeClientFailure('tun-settings-refresh', error)
            showNotice.error(
              toSafeClientErrorMessage(classifyClientError(error).kind, t),
            )
          }
        })
        .finally(() => {
          if (requestId === refreshRequestRef.current) setRefreshing(false)
        })
    },
    close: () => {
      closeDialog()
    },
  }))

  const onSave = useLockFn(async () => {
    if (mutationInFlightRef.current || busy || !authoritativeLoaded) {
      return
    }
    mutationInFlightRef.current = true
    setMutating(true)
    try {
      const routeExcludeAddress = routeExcludeAddressItems

      if (routeExcludeAddressError) {
        showNotice.error(
          'settings.modals.tun.messages.invalidRouteExcludeAddress',
        )
        return
      }

      const tun: TunSettingsView = {
        stack: values.stack,
        device:
          values.device === ''
            ? OS === 'macos'
              ? 'utun1024'
              : 'Mihomo'
            : values.device,
        autoRoute: values.autoRoute,
        routeExcludeAddress,
        ...(OS === 'linux'
          ? {
              autoRedirect: values.autoRedirect,
            }
          : { autoRedirect: false }),
        autoDetectInterface: values.autoDetectInterface,
        dnsHijack: values.dnsHijack[0] === '' ? [] : values.dnsHijack,
        strictRoute: values.strictRoute,
        mtu: values.mtu ?? 1500,
      }
      const applied = await runtimeActionController.updateTunSettings(tun)
      setValues(toTunSettingsForm(applied))
      refreshRequestRef.current += 1
      setOpen(false)
      showNotice.success('settings.modals.tun.messages.applied')
      void enhanceProfiles().catch((err: unknown) => {
        reportSafeClientFailure('tun-profile-enhance', err)
        showNotice.error(
          toSafeClientErrorMessage(classifyClientError(err).kind, t),
        )
      })
    } catch (err: unknown) {
      reportSafeClientFailure('tun-save', err)
      showNotice.error(
        toSafeClientErrorMessage(classifyClientError(err).kind, t),
      )
    } finally {
      mutationInFlightRef.current = false
      setMutating(false)
    }
  })

  const onReset = useLockFn(async () => {
    if (mutationInFlightRef.current || busy) return
    mutationInFlightRef.current = true
    setMutating(true)
    try {
      const applied =
        await runtimeActionController.updateTunSettings(defaultTunSettings())
      setValues(toTunSettingsForm(applied))
      setAuthoritativeLoaded(true)
    } catch (err: unknown) {
      reportSafeClientFailure('tun-reset', err)
      showNotice.error(
        toSafeClientErrorMessage(classifyClientError(err).kind, t),
      )
    } finally {
      mutationInFlightRef.current = false
      setMutating(false)
    }
  })

  return (
    <BaseDialog
      open={open}
      title={
        <Box display="flex" justifyContent="space-between" gap={1}>
          <Typography variant="h6">{t('settings.modals.tun.title')}</Typography>
          <Button
            variant="outlined"
            size="small"
            disabled={busy}
            onClick={onReset}
          >
            {t('shared.actions.resetToDefault')}
          </Button>
        </Box>
      }
      contentSx={{ width: 450 }}
      okBtn={t('shared.actions.save')}
      cancelBtn={t('shared.actions.cancel')}
      loading={mutating}
      disableOk={busy || !authoritativeLoaded}
      disableCancel={mutating}
      onClose={closeDialog}
      onCancel={closeDialog}
      onOk={onSave}
    >
      <List
        inert={busy || !authoritativeLoaded ? true : undefined}
        aria-busy={busy}
      >
        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText primary={t('settings.modals.tun.fields.stack')} />
          <StackModeSwitch
            value={values.stack}
            onChange={(value) => {
              setValues((v) => ({
                ...v,
                stack: value,
              }))
            }}
          />
        </ListItem>

        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText primary={t('settings.modals.tun.fields.device')} />
          <TextField
            autoComplete="new-password"
            size="small"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            sx={{ width: 250 }}
            value={values.device}
            placeholder="Mihomo"
            onChange={(e) =>
              setValues((v) => ({ ...v, device: e.target.value }))
            }
          />
        </ListItem>

        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText primary={t('settings.modals.tun.fields.autoRoute')} />
          <Switch
            edge="end"
            checked={values.autoRoute}
            onChange={(_, c) =>
              setValues((v) => ({
                ...v,
                autoRoute: c,
                autoRedirect: c ? v.autoRedirect : false,
              }))
            }
          />
        </ListItem>

        {OS === 'linux' && (
          <ListItem sx={{ padding: '5px 2px' }}>
            <ListItemText
              primary={t('settings.modals.tun.fields.autoRedirect')}
              sx={{ maxWidth: 'fit-content' }}
            />
            <TooltipIcon
              title={t('settings.modals.tun.tooltips.autoRedirect')}
              sx={{ opacity: values.autoRoute ? 0.7 : 0.3 }}
            />
            <Switch
              edge="end"
              checked={values.autoRedirect}
              onChange={(_, c) =>
                setValues((v) => ({
                  ...v,
                  autoRedirect: v.autoRoute ? c : v.autoRedirect,
                }))
              }
              disabled={!values.autoRoute}
              sx={{ marginLeft: 'auto' }}
            />
          </ListItem>
        )}

        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText primary={t('settings.modals.tun.fields.strictRoute')} />
          <Switch
            edge="end"
            checked={values.strictRoute}
            onChange={(_, c) => setValues((v) => ({ ...v, strictRoute: c }))}
          />
        </ListItem>

        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText
            primary={t('settings.modals.tun.fields.autoDetectInterface')}
          />
          <Switch
            edge="end"
            checked={values.autoDetectInterface}
            onChange={(_, c) =>
              setValues((v) => ({ ...v, autoDetectInterface: c }))
            }
          />
        </ListItem>

        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText primary={t('settings.modals.tun.fields.dnsHijack')} />
          <TextField
            autoComplete="new-password"
            size="small"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            sx={{ width: 250 }}
            value={values.dnsHijack.join(',')}
            placeholder={t('settings.modals.tun.tooltips.dnsHijack')}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                dnsHijack: e.target.value.split(','),
              }))
            }
          />
        </ListItem>

        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText primary={t('settings.modals.tun.fields.mtu')} />
          <TextField
            autoComplete="new-password"
            size="small"
            type="number"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            sx={{ width: 250 }}
            value={values.mtu}
            placeholder="1500"
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                mtu: parseInt(e.target.value),
              }))
            }
          />
        </ListItem>

        <BaseSplitChipEditor
          value={values.routeExcludeAddress}
          placeholder="192.168.0.0/16"
          ariaLabel={t('settings.modals.tun.fields.routeExcludeAddress')}
          disabled={!values.autoRoute}
          error={routeExcludeAddressError}
          helperText={routeExcludeAddressHelperText}
          onChange={(nextValue) =>
            setValues((v) => ({ ...v, routeExcludeAddress: nextValue }))
          }
          renderHeader={(modeToggle) => (
            <ListItem sx={{ padding: '5px 2px' }}>
              <ListItemText
                primary={t('settings.modals.tun.fields.routeExcludeAddress')}
              />
              {modeToggle ? (
                <Box sx={{ marginLeft: 'auto' }}>{modeToggle}</Box>
              ) : null}
            </ListItem>
          )}
        />
      </List>
    </BaseDialog>
  )
}
