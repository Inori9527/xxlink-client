import { ReactNode } from 'react'
import { ErrorBoundary, FallbackProps } from 'react-error-boundary'
import { useTranslation } from 'react-i18next'

import {
  reportSafeClientFailure,
  toSafeClientErrorMessage,
  toSafeClientFailureRecord,
  writeSafeClientFailureToClipboard,
} from '@/services/safe-client-error'

function ErrorFallback({ error }: FallbackProps) {
  const { t } = useTranslation()
  const failure = toSafeClientFailureRecord('base-error-boundary', error)
  const errorMessage = toSafeClientErrorMessage(failure.kind, t)
  const errorDetails = JSON.stringify(failure, null, 2)

  const handleReload = () => {
    window.location.reload()
  }

  const handleExport = () => {
    if (!navigator.clipboard) return
    void writeSafeClientFailureToClipboard('base-error-copy', error, (text) =>
      navigator.clipboard.writeText(text),
    ).catch((clipboardError) =>
      reportSafeClientFailure('base-error-copy', clipboardError),
    )
  }

  return (
    <div role="alert" style={{ padding: 16, fontFamily: 'inherit' }}>
      <h4 style={{ marginTop: 0 }}>{t('shared.errorBoundary.title')}</h4>
      <p style={{ marginTop: 0, opacity: 0.8 }}>
        {t('shared.errorBoundary.description')}
      </p>

      <pre
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: 'rgba(0,0,0,0.05)',
          padding: 8,
          borderRadius: 4,
        }}
      >
        {errorMessage}
      </pre>

      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <button
          type="button"
          onClick={handleReload}
          style={{
            padding: '6px 14px',
            borderRadius: 4,
            border: 'none',
            // Crash surface: stays MUI-theme-free on purpose. Brand color via
            // runtime CSS variable with a literal fallback for the case where
            // the theme hook never ran.
            background: 'var(--primary-main, #2F80ED)',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          {t('shared.errorBoundary.reload')}
        </button>
        <button
          type="button"
          onClick={handleExport}
          style={{
            padding: '6px 14px',
            borderRadius: 4,
            border: '1px solid #d1d5db',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          {t('shared.errorBoundary.exportLog')}
        </button>
      </div>

      <details>
        <summary style={{ cursor: 'pointer' }}>
          {t('shared.errorBoundary.detailsSummary')}
        </summary>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {errorDetails}
        </pre>
      </details>
    </div>
  )
}

interface Props {
  children?: ReactNode
}

export const BaseErrorBoundary = ({ children }: Props) => {
  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>{children}</ErrorBoundary>
  )
}
