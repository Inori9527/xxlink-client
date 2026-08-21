import {
  alpha,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
} from '@mui/material'
import type { ReactNode } from 'react'
import { useMatch, useNavigate, useResolvedPath } from 'react-router'

import { useVerge } from '@/hooks/use-verge'
import { designTokens, modeTokens } from '@/pages/_theme'

interface Props {
  to: string
  children: string
  icon: ReactNode[]
}
export const LayoutItem = (props: Props) => {
  const { to, children, icon } = props
  const { verge } = useVerge()
  const { menu_icon } = verge ?? {}
  const navCollapsed = verge?.collapse_navbar ?? true
  const resolved = useResolvedPath(to)
  const match = useMatch({ path: resolved.pathname, end: true })
  const navigate = useNavigate()

  const effectiveMenuIcon =
    navCollapsed && menu_icon === 'disable' ? 'monochrome' : menu_icon

  const iconSx = {
    color: 'inherit',
    minWidth: navCollapsed ? 'auto' : 34,
    width: navCollapsed ? 'auto' : 34,
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    '& .MuiSvgIcon-root': {
      fontSize: navCollapsed ? 21 : 22,
    },
  }

  return (
    <ListItem
      className={`layout-item${navCollapsed ? ' layout-item--collapsed' : ''}`}
      disablePadding
    >
      <ListItemButton
        selected={!!match}
        className="layout-item__button"
        sx={[
          {
            minHeight: navCollapsed ? 58 : 46,
            width: navCollapsed ? 58 : '100%',
            margin: navCollapsed ? '4px auto' : '3px 0',
            padding: navCollapsed ? '7px 4px 6px' : '9px 12px',
            flexDirection: navCollapsed ? 'column' : 'row',
            justifyContent: navCollapsed ? 'center' : 'flex-start',
            borderRadius: navCollapsed
              ? designTokens.radius.md
              : designTokens.radius.sm,
            color: 'text.secondary',
            transition:
              'background-color 180ms ease, box-shadow 180ms ease, color 180ms ease, transform 180ms ease',
            '& .MuiListItemText-primary': {
              color: 'inherit',
              fontWeight: navCollapsed ? 700 : 750,
              fontSize: navCollapsed ? 10.5 : 14,
              lineHeight: 1.2,
              letterSpacing: navCollapsed ? '0.01em' : 'normal',
              textAlign: navCollapsed ? 'center' : 'left',
            },
          },
          ({ palette: { mode, primary } }) => {
            const tokens = modeTokens(mode)
            const selectedBackground = alpha(primary.main, 0.14)

            return {
              '&:hover': {
                backgroundColor: alpha(primary.main, 0.08),
                color: 'text.primary',
              },
              '&.Mui-selected': {
                backgroundColor: selectedBackground,
                color: primary.main,
                boxShadow: `0 0 14px ${tokens.glowPrimary}`,
              },
              '&.Mui-selected:hover': {
                backgroundColor: alpha(primary.main, 0.18),
                color: primary.main,
              },
              '&:focus-visible': {
                outline: `2px solid ${alpha(primary.main, 0.72)}`,
                outlineOffset: 2,
              },
              '&.Mui-selected .MuiListItemIcon-root': {
                color: primary.main,
              },
            }
          },
        ]}
        title={navCollapsed ? children : undefined}
        aria-label={navCollapsed ? children : undefined}
        onClick={() => navigate(to)}
      >
        {(effectiveMenuIcon === 'monochrome' || !effectiveMenuIcon) && (
          <ListItemIcon className="layout-item__icon" sx={iconSx}>
            {icon[0]}
          </ListItemIcon>
        )}
        {effectiveMenuIcon === 'colorful' && (
          <ListItemIcon className="layout-item__icon" sx={iconSx}>
            {icon[1]}
          </ListItemIcon>
        )}
        <ListItemText
          className="layout-item__label"
          sx={{
            minWidth: 0,
            flex: navCollapsed ? '0 0 auto' : '1 1 auto',
            margin: navCollapsed
              ? '2px 0 0'
              : effectiveMenuIcon === 'disable'
                ? 0
                : '0 0 0 2px',
          }}
          primary={children}
        />
      </ListItemButton>
    </ListItem>
  )
}
