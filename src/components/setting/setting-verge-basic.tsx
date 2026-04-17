import { MenuItem, Select, Switch } from '@mui/material'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DialogRef, TooltipIcon } from '@/components/base'
import { useVerge } from '@/hooks/use-verge'
import { navItems } from '@/pages/_routers'
import { supportedLanguages } from '@/services/i18n'
import getSystem from '@/utils/get-system'

import { ConfigViewer } from './mods/config-viewer'
import { GuardState } from './mods/guard-state'
import { MiscViewer } from './mods/misc-viewer'
import { SettingItem, SettingList } from './mods/setting-comp'
import { ThemeModeSwitch } from './mods/theme-mode-switch'
import { UpdateViewer } from './mods/update-viewer'

interface Props {
  onError?: (err: Error) => void
}

const OS = getSystem()

const ADVANCED_SETTINGS_STORAGE_KEY = 'xxlink:show-advanced-settings'

const readAdvancedSettingsFlag = (): boolean => {
  try {
    return localStorage.getItem(ADVANCED_SETTINGS_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

const languageOptions = supportedLanguages.map((code) => {
  const labels: { [key: string]: string } = {
    zh: '中文',
    en: 'English',
  }
  const label = labels[code] || code
  return { code, label }
})

const SettingVergeBasic = ({ onError }: Props) => {
  const { t } = useTranslation()

  const { verge, patchVerge, mutateVerge } = useVerge()
  const {
    theme_mode,
    language,
    tray_event,
    start_page,
    auto_connect_on_launch,
  } = verge ?? {}
  const configRef = useRef<DialogRef>(null)
  const miscRef = useRef<DialogRef>(null)
  const updateRef = useRef<DialogRef>(null)

  const [showAdvanced, setShowAdvanced] = useState<boolean>(
    readAdvancedSettingsFlag,
  )

  const onToggleShowAdvanced = (_: unknown, checked: boolean) => {
    setShowAdvanced(checked)
    try {
      localStorage.setItem(ADVANCED_SETTINGS_STORAGE_KEY, String(checked))
      // Notify same-window listeners; 'storage' event only fires cross-tab.
      window.dispatchEvent(
        new CustomEvent('xxlink:advanced-settings-changed', {
          detail: checked,
        }),
      )
    } catch {
      /* ignore */
    }
  }

  const onChangeData = (patch: any) => {
    mutateVerge({ ...verge, ...patch }, false)
  }

  return (
    <SettingList title={t('settings.components.verge.basic.title')}>
      <ConfigViewer ref={configRef} />
      <MiscViewer ref={miscRef} />
      <UpdateViewer ref={updateRef} />

      <SettingItem label={t('settings.components.verge.basic.fields.language')}>
        <GuardState
          value={language ?? 'en'}
          onCatch={onError}
          onFormat={(e: any) => e.target.value}
          onChange={(e) => onChangeData({ language: e })}
          onGuard={(e) => patchVerge({ language: e })}
        >
          <Select size="small" sx={{ width: 110, '> div': { py: '7.5px' } }}>
            {languageOptions.map(({ code, label }) => (
              <MenuItem key={code} value={code}>
                {label}
              </MenuItem>
            ))}
          </Select>
        </GuardState>
      </SettingItem>

      <SettingItem
        label={t('settings.components.verge.basic.fields.themeMode')}
      >
        <GuardState
          value={theme_mode}
          onCatch={onError}
          onChange={(e) => onChangeData({ theme_mode: e })}
          onGuard={(e) => patchVerge({ theme_mode: e })}
        >
          <ThemeModeSwitch />
        </GuardState>
      </SettingItem>

      {OS !== 'linux' && (
        <SettingItem
          label={t('settings.components.verge.basic.fields.trayClickEvent')}
        >
          <GuardState
            value={tray_event ?? 'main_window'}
            onCatch={onError}
            onFormat={(e: any) => e.target.value}
            onChange={(e) => onChangeData({ tray_event: e })}
            onGuard={(e) => patchVerge({ tray_event: e })}
          >
            <Select size="small" sx={{ width: 140, '> div': { py: '7.5px' } }}>
              <MenuItem value="main_window">
                {t(
                  'settings.components.verge.basic.trayOptions.showMainWindow',
                )}
              </MenuItem>
              <MenuItem value="tray_menu">
                {t('settings.components.verge.basic.trayOptions.showTrayMenu')}
              </MenuItem>
              <MenuItem value="system_proxy">
                {t('settings.sections.system.toggles.systemProxy')}
              </MenuItem>
              <MenuItem value="tun_mode">
                {t('settings.sections.system.toggles.tunMode')}
              </MenuItem>
              <MenuItem value="disable">
                {t('settings.components.verge.basic.trayOptions.disable')}
              </MenuItem>
            </Select>
          </GuardState>
        </SettingItem>
      )}

      <SettingItem
        label={t('settings.components.verge.basic.fields.startPage')}
      >
        <GuardState
          value={start_page ?? '/connect'}
          onCatch={onError}
          onFormat={(e: any) => e.target.value}
          onChange={(e) => onChangeData({ start_page: e })}
          onGuard={(e) => patchVerge({ start_page: e })}
        >
          <Select size="small" sx={{ width: 140, '> div': { py: '7.5px' } }}>
            {navItems.map((page: { label: string; path: string }) => {
              return (
                <MenuItem key={page.path} value={page.path}>
                  {t(page.label)}
                </MenuItem>
              )
            })}
          </Select>
        </GuardState>
      </SettingItem>

      <SettingItem
        label={t('settings.components.verge.basic.fields.autoConnectOnLaunch')}
        extra={
          <TooltipIcon
            title={t(
              'settings.components.verge.basic.tooltips.autoConnectOnLaunch',
            )}
            sx={{ opacity: '0.7' }}
          />
        }
      >
        <GuardState
          value={auto_connect_on_launch ?? true}
          valueProps="checked"
          onCatch={onError}
          onFormat={(_: unknown, checked: boolean) => checked}
          onChange={(e) => onChangeData({ auto_connect_on_launch: e })}
          onGuard={(e) => patchVerge({ auto_connect_on_launch: e })}
        >
          <Switch edge="end" />
        </GuardState>
      </SettingItem>

      <SettingItem
        onClick={() => miscRef.current?.open()}
        label={t('settings.components.verge.basic.fields.misc')}
      />

      <SettingItem
        label={t('settings.components.verge.basic.fields.showAdvancedSettings')}
        extra={
          <TooltipIcon
            title={t(
              'settings.components.verge.basic.tooltips.showAdvancedSettings',
            )}
            sx={{ opacity: '0.7' }}
          />
        }
      >
        <Switch
          edge="end"
          checked={showAdvanced}
          onChange={onToggleShowAdvanced}
        />
      </SettingItem>
    </SettingList>
  )
}

export default SettingVergeBasic
