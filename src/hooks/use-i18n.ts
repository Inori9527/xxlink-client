import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import {
  changeLanguage,
  resolveLanguage,
  supportedLanguages,
} from '@/services/i18n'
import { reportSafeClientFailure } from '@/services/safe-client-error'

import { useVerge } from './use-verge'

export const useI18n = () => {
  const { i18n, t } = useTranslation()
  const { patchVerge } = useVerge()
  const [isLoading, setIsLoading] = useState(false)

  const switchLanguage = useCallback(
    async (language: string) => {
      const targetLanguage = resolveLanguage(language)

      if (!supportedLanguages.includes(targetLanguage)) {
        reportSafeClientFailure(
          'i18n-switch-language',
          new Error('Unsupported language'),
        )
        return
      }

      if (i18n.language === targetLanguage) {
        return
      }

      setIsLoading(true)
      try {
        await changeLanguage(targetLanguage)

        if (patchVerge) {
          await patchVerge({ language: targetLanguage })
        }
      } catch (error) {
        reportSafeClientFailure('i18n-switch-language', error)
      } finally {
        setIsLoading(false)
      }
    },
    [i18n.language, patchVerge],
  )

  // Facade for user-facing language pickers: persist the preference only and
  // let the layout language effect (the single writer) apply it to i18n.
  // Calling switchLanguage from a picker races that effect and reverts the
  // switch; pages must not call patchVerge directly (runtime action boundary).
  const selectLanguage = useCallback(
    async (language: string) => {
      const targetLanguage = resolveLanguage(language)

      if (!supportedLanguages.includes(targetLanguage)) {
        reportSafeClientFailure(
          'i18n-switch-language',
          new Error('Unsupported language'),
        )
        return
      }

      if (!patchVerge) {
        return
      }

      setIsLoading(true)
      try {
        await patchVerge({ language: targetLanguage })
      } catch (error) {
        reportSafeClientFailure('i18n-switch-language', error)
      } finally {
        setIsLoading(false)
      }
    },
    [patchVerge],
  )

  return {
    currentLanguage: i18n.language,
    supportedLanguages,
    switchLanguage,
    selectLanguage,
    isLoading,
    t,
  }
}
