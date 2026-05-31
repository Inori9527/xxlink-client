import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core'
import {
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
          ({ palette: { mode } }) => {
            const color = mode === 'light' ? '#111111' : '#F4F4F5'
            return {
              '&.Mui-selected': {
                background: 'transparent',
                border: 0,
                boxShadow: 'none',
              },
              '&.Mui-selected:hover': { background: 'transparent' },
              '&.Mui-selected .MuiListItemText-primary': {
                color,
                fontWeight: 950,
              },
              '&.Mui-selected .MuiListItemIcon-root': { color },
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
          <ListItemIcon
            sx={{
              color: 'text.primary',
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
