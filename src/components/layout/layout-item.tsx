import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core'
import {
  alpha,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
} from '@mui/material'
import type { CSSProperties, ReactNode } from 'react'
import { useMatch, useNavigate, useResolvedPath } from 'react-router'

import { useVerge } from '@/hooks/use-verge'

interface SortableProps {
  setNodeRef?: (element: HTMLElement | null) => void
  attributes?: DraggableAttributes
  listeners?: DraggableSyntheticListeners
  style?: CSSProperties
  isDragging?: boolean
  disabled?: boolean
}

interface Props {
  to: string
  children: string
  icon: ReactNode[]
  sortable?: SortableProps
}
export const LayoutItem = (props: Props) => {
  const { to, children, icon, sortable } = props
  const { verge } = useVerge()
  const { menu_icon } = verge ?? {}
  const navCollapsed = verge?.collapse_navbar ?? false
  const resolved = useResolvedPath(to)
  const match = useMatch({ path: resolved.pathname, end: true })
  const navigate = useNavigate()

  const effectiveMenuIcon =
    navCollapsed && menu_icon === 'disable' ? 'monochrome' : menu_icon

  const { setNodeRef, attributes, listeners, style, isDragging, disabled } =
    sortable ?? {}

  const draggable = Boolean(sortable) && !disabled
  const dragHandleProps = draggable
    ? { ...(attributes ?? {}), ...(listeners ?? {}) }
    : undefined

  return (
    <ListItem
      ref={setNodeRef}
      style={style}
      sx={[
        { py: 0.25, maxWidth: 220, mx: 'auto', padding: '3px 0px' },
        isDragging ? { opacity: 0.78 } : {},
      ]}
    >
      <ListItemButton
        selected={!!match}
        {...(dragHandleProps ?? {})}
        sx={[
          {
            minHeight: 44,
            borderRadius: 999,
            marginLeft: 1,
            paddingLeft: 1.25,
            paddingRight: 1.25,
            marginRight: 1,
            cursor: draggable ? 'grab' : 'pointer',
            '&:active': draggable ? { cursor: 'grabbing' } : {},
            '& .MuiListItemText-primary': {
              color: 'text.primary',
              fontWeight: '800',
              fontSize: 14,
            },
          },
          ({ palette: { mode, primary } }) => {
            const bgcolor =
              mode === 'light'
                ? alpha(primary.main, 0.12)
                : alpha(primary.main, 0.18)
            const color = mode === 'light' ? '#172033' : '#F4F4F5'
            return {
              '&.Mui-selected': {
                bgcolor,
                border: `1px solid ${alpha(primary.main, mode === 'light' ? 0.18 : 0.26)}`,
                boxShadow:
                  mode === 'dark'
                    ? `inset 0 1px 0 ${alpha('#fff', 0.08)}`
                    : `0 8px 24px ${alpha(primary.main, 0.08)}`,
              },
              '&.Mui-selected:hover': { bgcolor },
              '&.Mui-selected .MuiListItemText-primary': { color },
            }
          },
        ]}
        title={navCollapsed ? children : undefined}
        aria-label={navCollapsed ? children : undefined}
        onClick={() => navigate(to)}
      >
        {(effectiveMenuIcon === 'monochrome' || !effectiveMenuIcon) && (
          <ListItemIcon
            sx={{
              color: 'text.primary',
              marginLeft: '2px',
              cursor: draggable ? 'grab' : 'inherit',
              minWidth: 34,
              '& .MuiSvgIcon-root': {
                fontSize: 22,
              },
            }}
          >
            {icon[0]}
          </ListItemIcon>
        )}
        {effectiveMenuIcon === 'colorful' && (
          <ListItemIcon sx={{ cursor: draggable ? 'grab' : 'inherit' }}>
            {icon[1]}
          </ListItemIcon>
        )}
        <ListItemText
          sx={{
            textAlign: 'left',
            marginLeft: effectiveMenuIcon === 'disable' ? 0 : 0.25,
          }}
          primary={children}
        />
      </ListItemButton>
    </ListItem>
  )
}
