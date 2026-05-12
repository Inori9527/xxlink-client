import AssignmentRoundedIcon from '@mui/icons-material/AssignmentRounded'
import PersonRoundedIcon from '@mui/icons-material/PersonRounded'
import PowerSettingsNewRoundedIcon from '@mui/icons-material/PowerSettingsNewRounded'
import WifiRoundedIcon from '@mui/icons-material/WifiRounded'
import { createBrowserRouter, type RouteObject } from 'react-router'
import { Navigate } from 'react-router'

import HomeSvg from '@/assets/image/itemicon/home.svg?react'
import ProxiesSvg from '@/assets/image/itemicon/proxies.svg?react'
import { RequireAuth } from '@/components/require-auth'
import { AppDataProvider } from '@/providers/app-data-provider'

import Layout from './_layout'
import ConnectPage from './connect'
import LoginPage from './login'
import MinePage from './mine'
import NodesPage from './nodes'
import PlansPage from './plans'
import RegisterPage from './register'

/**
 * navItems drives both the sidebar navigation and the router.
 *
 * Rules, Logs, and API Keys are intentionally excluded from
 * this list so they do not appear in the navigation bar. Their routes are
 * still registered below via hiddenRoutes so the pages remain reachable if
 * needed.
 */
export const navItems = [
  {
    label: 'layout.components.navigation.tabs.connect',
    path: '/connect',
    icon: [
      <PowerSettingsNewRoundedIcon key="mui" />,
      <PowerSettingsNewRoundedIcon key="svg" />,
    ],
    Component: ConnectPage,
  },
  {
    label: 'layout.components.navigation.tabs.proxies',
    path: '/nodes',
    icon: [<WifiRoundedIcon key="mui" />, <ProxiesSvg key="svg" />],
    Component: NodesPage,
  },
  {
    label: 'layout.components.navigation.tabs.plans',
    path: '/plans',
    icon: [
      <AssignmentRoundedIcon key="mui" />,
      <AssignmentRoundedIcon key="svg" />,
    ],
    Component: PlansPage,
  },
  {
    label: 'layout.components.navigation.tabs.mine',
    path: '/mine',
    icon: [<PersonRoundedIcon key="mui" />, <HomeSvg key="svg" />],
    Component: MinePage,
  },
]

/** Routes for pages hidden from the nav bar but still routable. */
const hiddenRoutes: RouteObject[] = [
  {
    path: '/home',
    lazy: async () => ({ Component: (await import('./home')).default }),
  },
  {
    path: '/proxies',
    lazy: async () => ({ Component: (await import('./proxies')).default }),
  },
  {
    path: '/profile',
    lazy: async () => ({ Component: (await import('./profiles')).default }),
  },
  {
    path: '/connections',
    lazy: async () => ({ Component: (await import('./connections')).default }),
  },
  {
    path: '/rules',
    lazy: async () => ({ Component: (await import('./rules')).default }),
  },
  {
    path: '/unlock',
    lazy: async () => ({ Component: (await import('./unlock')).default }),
  },
  {
    path: '/promo-code',
    lazy: async () => ({ Component: (await import('./promo-code')).default }),
  },
  {
    path: '/settings',
    lazy: async () => ({ Component: (await import('./settings')).default }),
  },
  {
    path: '/announcements',
    lazy: async () => ({
      Component: (await import('./announcement-center')).default,
    }),
  },
  {
    path: '/logs',
    Component: () => null /* KeepAlive: real LogsPage rendered in Layout */,
  },
  {
    path: '/api-keys',
    lazy: async () => ({ Component: (await import('./api-keys')).default }),
  },
]

export const router = createBrowserRouter([
  // Public routes — accessible without authentication
  { path: '/login', Component: LoginPage },
  { path: '/register', Component: RegisterPage },

  // Protected routes — wrapped in the auth guard
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppDataProvider>
          <Layout />
        </AppDataProvider>
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/connect" replace /> },
      ...navItems.map(
        (item) =>
          ({
            path: item.path,
            Component: item.Component,
          }) as RouteObject,
      ),
      ...hiddenRoutes,
    ],
  },
])
