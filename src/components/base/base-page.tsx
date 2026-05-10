import { Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import React, { ReactNode } from 'react'

import { BaseErrorBoundary } from './base-error-boundary'

interface Props {
  title?: React.ReactNode // the page title
  header?: React.ReactNode // something behind title
  contentStyle?: React.CSSProperties
  children?: ReactNode
  full?: boolean
}

export const BasePage: React.FC<Props> = (props) => {
  const { title, header, contentStyle, full, children } = props
  const theme = useTheme()

  const isDark = theme.palette.mode === 'dark'
  const pageBg = isDark
    ? 'radial-gradient(circle at 88% 0%, rgba(139, 92, 246, 0.10), transparent 30%), #0D0E11'
    : 'linear-gradient(135deg, #F8FAFF 0%, #EEF4FF 100%)'
  const panelBg = isDark ? '#0B0C0F' : '#FFFFFF'

  return (
    <BaseErrorBoundary>
      <div className="base-page">
        <header data-tauri-drag-region="true" style={{ userSelect: 'none' }}>
          <Typography
            sx={{ fontSize: '20px', fontWeight: 800, letterSpacing: '-0.02em' }}
            data-tauri-drag-region="true"
          >
            {title}
          </Typography>

          {header}
        </header>

        <div
          className={full ? 'base-container no-padding' : 'base-container'}
          style={{ backgroundColor: panelBg }}
        >
          <section
            style={{
              background: pageBg,
            }}
          >
            <div className="base-content" style={contentStyle}>
              {children}
            </div>
          </section>
        </div>
      </div>
    </BaseErrorBoundary>
  )
}
