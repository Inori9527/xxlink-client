import type { SVGProps } from 'react'
import { useMatch, useNavigate, useResolvedPath } from 'react-router'

export type LayoutIconName = 'connect' | 'nodes' | 'plans' | 'mine'

interface Props {
  to: string
  children: string
  icon: LayoutIconName
}

const iconProps: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
}

const LayoutIcon = ({ name }: { name: LayoutIconName }) => {
  switch (name) {
    case 'connect':
      return (
        <svg {...iconProps}>
          <path d="M12 3v8" />
          <path d="M6.5 6.5a8 8 0 1 0 11 0" />
        </svg>
      )
    case 'plans':
      return (
        <svg {...iconProps}>
          <rect x="3.5" y="5.5" width="17" height="13" rx="2.2" />
          <path d="M7 10h10M7 14h5" />
        </svg>
      )
    case 'mine':
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="8" r="3.2" />
          <path d="M5 20c.8-3.3 3.2-5 7-5s6.2 1.7 7 5" />
        </svg>
      )
    case 'nodes':
      return (
        <svg {...iconProps}>
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
      )
  }
}

export const LayoutItem = (props: Props) => {
  const { to, children, icon } = props
  const resolved = useResolvedPath(to)
  const match = useMatch({ path: resolved.pathname, end: true })
  const navigate = useNavigate()
  const active = Boolean(match)

  return (
    <div className="layout-item">
      <button
        type="button"
        className={`layout-item__button${active ? ' is-active' : ''}`}
        aria-current={active ? 'page' : undefined}
        onClick={() => navigate(to)}
      >
        <span className="layout-item__icon">
          <LayoutIcon name={icon} />
        </span>
        <span className="layout-item__label">{children}</span>
      </button>
    </div>
  )
}
