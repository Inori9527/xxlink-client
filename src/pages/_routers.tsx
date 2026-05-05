import AssignmentRoundedIcon from '@mui/icons-material/AssignmentRounded'
import HomeRoundedIcon from '@mui/icons-material/HomeRounded'
import LocalOfferRoundedIcon from '@mui/icons-material/LocalOfferRounded'
import LockOpenRoundedIcon from '@mui/icons-material/LockOpenRounded'
import PowerSettingsNewRoundedIcon from '@mui/icons-material/PowerSettingsNewRounded'
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded'
import WifiRoundedIcon from '@mui/icons-material/WifiRounded'
import { createBrowserRouter, type RouteObject } from 'react-router'
import { Navigate } from 'react-router'

import HomeSvg from '@/assets/image/itemicon/home.svg?react'
import ProxiesSvg from '@/assets/image/itemicon/proxies.svg?react'
import SettingsSvg from '@/assets/image/itemicon/settings.svg?react'
import { RequireAuth } from '@/components/require-auth'

import Layout from './_layout'
import ApiKeysPage from './api-keys'
import ConnectPage from './connect'
import ConnectionsPage from './connections'
import HomePage from './home'
import LoginPage from './login'
import PlansPage from './plans'
import ProfilesPage from './profiles'
import PromoCodePage from './promo-code'
import ProxiesPage from './proxies'
import RegisterPage from './register'
import RulesPage from './rules'
import SettingsPage from './settings'
import UnlockPage from './unlock'

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
    label: 'layout.components.navigation.tabs.home',
    path: '/home',
    icon: [<HomeRoundedIcon key="mui" />, <HomeSvg key="svg" />],
    Component: HomePage,
  },
  {
    label: 'layout.components.navigation.tabs.proxies',
    path: '/proxies',
    icon: [<WifiRoundedIcon key="mui" />, <ProxiesSvg key="svg" />],
    Component: ProxiesPage,
  },
  {
    label: 'layout.components.navigation.tabs.unlock',
    path: '/unlock',
    icon: [
      <LockOpenRoundedIcon key="mui" />,
      <LockOpenRoundedIcon key="svg" />,
    ],
    Component: UnlockPage,
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
    label: 'layout.components.navigation.tabs.promoCode',
    path: '/promo-code',
    icon: [
      <LocalOfferRoundedIcon key="mui" />,
      <LocalOfferRoundedIcon key="svg" />,
    ],
    Component: PromoCodePage,
  },
  {
    label: 'layout.components.navigation.tabs.settings',
    path: '/settings',
    icon: [<SettingsRoundedIcon key="mui" />, <SettingsSvg key="svg" />],
    Component: SettingsPage,
  },
]

/** Routes for pages hidden from the nav bar but still routable. */
const hiddenRoutes: RouteObject[] = [
  { path: '/profile', Component: ProfilesPage },
  { path: '/connections', Component: ConnectionsPage },
  { path: '/rules', Component: RulesPage },
  {
    path: '/logs',
    Component: () => null /* KeepAlive: real LogsPage rendered in Layout */,
  },
  { path: '/api-keys', Component: ApiKeysPage },
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
        <Layout />
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
