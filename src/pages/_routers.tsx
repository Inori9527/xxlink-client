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

/** navItems drives both the fixed sidebar navigation and the router. */
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

const redirectRoutes: RouteObject[] = [
  { path: '/home', element: <Navigate to="/connect" replace /> },
  { path: '/profile', element: <Navigate to="/connect" replace /> },
  { path: '/connections', element: <Navigate to="/connect" replace /> },
  { path: '/rules', element: <Navigate to="/connect" replace /> },
  { path: '/unlock', element: <Navigate to="/connect" replace /> },
  { path: '/proxies', element: <Navigate to="/nodes" replace /> },
  { path: '/settings', element: <Navigate to="/mine" replace /> },
  { path: '/logs', element: <Navigate to="/mine" replace /> },
  { path: '/api-keys', element: <Navigate to="/mine" replace /> },
  { path: '/promo-code', element: <Navigate to="/mine" replace /> },
  { path: '/announcements', element: <Navigate to="/mine" replace /> },
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
      ...redirectRoutes,
    ],
  },
])
