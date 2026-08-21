import { createBrowserRouter, type RouteObject } from 'react-router'
import { Navigate } from 'react-router'

import { RequireAuth } from '@/components/require-auth'
import { AppDataProvider } from '@/providers/app-data-provider'

import Layout from './_layout'
import ConnectPage from './connect'
import LoginPage from './login'
import MinePage from './mine'
import NodesPage from './nodes'
import PlansPage from './plans'
import RegisterPage from './register'

/** navItems is the route registry; showInTabBar controls primary visibility. */
export const navItems = [
  {
    label: 'layout.components.navigation.tabs.connect',
    path: '/connect',
    showInTabBar: true,
    icon: 'connect',
    Component: ConnectPage,
  },
  {
    label: 'layout.components.navigation.tabs.proxies',
    path: '/nodes',
    showInTabBar: false,
    icon: 'nodes',
    Component: NodesPage,
  },
  {
    label: 'layout.components.navigation.tabs.plans',
    path: '/plans',
    showInTabBar: true,
    icon: 'plans',
    Component: PlansPage,
  },
  {
    label: 'layout.components.navigation.tabs.mine',
    path: '/mine',
    showInTabBar: true,
    icon: 'mine',
    Component: MinePage,
  },
] as const

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
