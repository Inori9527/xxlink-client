import {
  showNotice,
  showSafeClientFailureNotice,
} from '@/services/notice-service'
import { reportSafeClientFailure } from '@/services/safe-client-error'

type NavigateFunction = (path: string, options?: any) => void
type TranslateFunction = (key: string) => string

export const handleNoticeMessage = (
  status: string,
  msg: string,
  t: TranslateFunction,
  navigate: NavigateFunction,
) => {
  const noticeError = () => new Error(msg || 'Backend notice failed')
  const showGenericFailure = () => {
    showSafeClientFailureNotice('layout-notice-error', noticeError())
  }
  const showTranslatedFailure = (key: string) => {
    reportSafeClientFailure('layout-notice-error', noticeError())
    showNotice.error(key)
  }

  const handlers: Record<string, () => void> = {
    'import_sub_url::ok': () => {
      // 空 msg 传入，我们不希望导致 后端-前端-后端 死循环，这里只做提醒。
      // 未来细分事件通知时，可以考虑传入订阅 ID 或其他标识符
      // navigate("/profile", { state: { current: msg } });
      navigate('/profile')
      showNotice.success(
        'shared.feedback.notifications.importSubscriptionSuccess',
      )
    },
    'import_sub_url::error': () => {
      navigate('/profile')
      showGenericFailure()
    },
    'set_config::error': showGenericFailure,
    update_with_clash_proxy: () =>
      showNotice.success(
        'settings.feedback.notifications.updater.withClashProxySuccess',
      ),
    update_failed_even_with_clash: () =>
      showTranslatedFailure(
        'settings.feedback.notifications.updater.withClashProxyFailed',
      ),
    'reactivate_profiles::error': showGenericFailure,
    update_failed: showGenericFailure,
    'config_validate::boot_error': () =>
      showTranslatedFailure('shared.feedback.validation.config.bootFailed'),
    'config_validate::core_arch_mismatch': () =>
      showTranslatedFailure(
        'shared.feedback.validation.config.coreArchMismatch',
      ),
    'config_validate::core_change': () =>
      showTranslatedFailure(
        'shared.feedback.validation.config.coreChangeFailed',
      ),
    'config_validate::error': () =>
      showTranslatedFailure('shared.feedback.validation.config.failed'),
    'config_validate::process_terminated': () =>
      showTranslatedFailure(
        'shared.feedback.validation.config.processTerminated',
      ),
    'config_validate::stdout_error': () =>
      showTranslatedFailure('shared.feedback.validation.config.failed'),
    'config_validate::script_error': () =>
      showTranslatedFailure('shared.feedback.validation.script.fileError'),
    'config_validate::script_syntax_error': () =>
      showTranslatedFailure('shared.feedback.validation.script.syntaxError'),
    'config_validate::script_missing_main': () =>
      showTranslatedFailure('shared.feedback.validation.script.missingMain'),
    'config_validate::file_not_found': () =>
      showTranslatedFailure('shared.feedback.validation.script.fileNotFound'),
    'config_validate::yaml_syntax_error': () =>
      showTranslatedFailure('shared.feedback.validation.yaml.syntaxError'),
    'config_validate::yaml_read_error': () =>
      showTranslatedFailure('shared.feedback.validation.yaml.readError'),
    'config_validate::yaml_mapping_error': () =>
      showTranslatedFailure('shared.feedback.validation.yaml.mappingError'),
    'config_validate::yaml_key_error': () =>
      showTranslatedFailure('shared.feedback.validation.yaml.keyError'),
    'config_validate::yaml_error': () =>
      showTranslatedFailure('shared.feedback.validation.yaml.generalError'),
    'config_validate::merge_syntax_error': () =>
      showTranslatedFailure('shared.feedback.validation.merge.syntaxError'),
    'config_validate::merge_mapping_error': () =>
      showTranslatedFailure('shared.feedback.validation.merge.mappingError'),
    'config_validate::merge_key_error': () =>
      showTranslatedFailure('shared.feedback.validation.merge.keyError'),
    'config_validate::merge_error': () =>
      showTranslatedFailure('shared.feedback.validation.merge.generalError'),
    'config_core::change_success': () =>
      showNotice.success('settings.feedback.notifications.clash.changeSuccess'),
    'config_core::change_error': () =>
      showTranslatedFailure(
        'settings.feedback.notifications.clash.changeFailed',
      ),
  }

  const handler = handlers[status]
  if (handler) {
    handler()
  } else {
    reportSafeClientFailure(
      'layout-notice-unhandled',
      new Error('Unhandled backend notice status'),
    )
  }
}
