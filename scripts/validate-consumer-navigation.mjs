import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// PROVES:         Source text only. That the source TEXT of the files it reads matches
//                 the post-2026-08-21 bottom-tab-bar shape, AND one path-absence
//                 fact: recreating use-nav-menu-order.ts fails the guard even when
//                 every read text is unchanged.
// DOES NOT PROVE: Anything about running code.

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const readSource = (relativePath) =>
  readFileSync(resolve(rootDir, relativePath), 'utf8')

const routerSource = readSource('src/pages/_routers.tsx')
const layoutSource = readSource('src/pages/_layout.tsx')
const layoutStylesSource = readSource('src/assets/styles/layout.scss')
const layoutItemSource = readSource('src/components/layout/layout-item.tsx')
const appDataProviderSource = readSource('src/providers/app-data-provider.tsx')
const mineSource = readSource('src/pages/mine.tsx')
const plansSource = readSource('src/pages/plans.tsx')
const vergeTypesSource = readSource('src/types/global.d.ts')

const expectedNavPaths = ['/connect', '/nodes', '/plans', '/mine']
const navItemsSource = routerSource
  .split('export const navItems = [', 2)[1]
  .split('const redirectRoutes', 2)[0]
const navPathMatches = [...navItemsSource.matchAll(/path:\s*'([^']+)'/g)].map(
  ([, path]) => path,
)

// 2026-08-21 bottom-tab-bar redesign: navItems remains the route source of truth,
// including the reachable /nodes route that is no longer a primary tab.
assert.deepEqual(
  navPathMatches,
  expectedNavPaths,
  'consumer route registry order changed',
)

// 2026-08-21 bottom-tab-bar redesign: exactly three visible tabs are allowed,
// and their labels/routes must stay in the approved Connect/Plans/Mine order.
const expectedTabBarItems = [
  {
    label: 'layout.components.navigation.tabs.connect',
    path: '/connect',
  },
  {
    label: 'layout.components.navigation.tabs.plans',
    path: '/plans',
  },
  {
    label: 'layout.components.navigation.tabs.mine',
    path: '/mine',
  },
]
const tabBarItemMatches = [
  ...navItemsSource.matchAll(
    /label:\s*'([^']+)',\s*path:\s*'([^']+)',\s*showInTabBar:\s*true/g,
  ),
].map(([, label, path]) => ({ label, path }))
assert.deepEqual(
  tabBarItemMatches,
  expectedTabBarItems,
  'bottom tab bar must expose exactly Connect, Plans, and Mine',
)
assert.match(
  navItemsSource,
  /path:\s*'\/nodes',\s*showInTabBar:\s*false/,
  '/nodes must remain route-reachable but hidden from the tab bar',
)
assert.match(
  layoutSource,
  // Lazy accessor: _routers imports Layout back, so navItems sits in the
  // import cycle's TDZ at module-evaluation time (2026-08-21 fix).
  /const getTabBarItems = \(\) =>\s*navItems\.filter\(\(item\) => item\.showInTabBar\)/,
  'layout must derive visible tabs from navItems metadata',
)
assert.match(
  layoutSource,
  /getTabBarItems\(\)\.map/,
  'tab bar must render the derived tab list',
)
// 2026-08-21 W5 review finding 5: the nav gained a localized aria-label, so the
// element spans multiple JSX lines; the assertion still requires the same
// class and the getTabBarItems() source.
assert.match(
  layoutSource,
  /<nav\s+className="bottom-tab-bar"[\s\S]*getTabBarItems\(\)\.map\(/,
  'layout must render the bottom tab bar from the filtered route registry',
)
assert.match(
  routerSource,
  /\.\.\.navItems\.map\([\s\S]*path: item\.path/,
  '/nodes must remain reachable through the protected router',
)

const expectedRedirects = new Map([
  ['/home', '/connect'],
  ['/profile', '/connect'],
  ['/connections', '/connect'],
  ['/rules', '/connect'],
  ['/unlock', '/connect'],
  ['/proxies', '/nodes'],
  ['/settings', '/mine'],
  ['/logs', '/mine'],
  ['/api-keys', '/mine'],
  ['/promo-code', '/mine'],
  ['/announcements', '/mine'],
])

const retiredRouteModules = new Map([
  ['/home', './home'],
  ['/proxies', './proxies'],
  ['/profile', './profiles'],
  ['/connections', './connections'],
  ['/rules', './rules'],
  ['/unlock', './unlock'],
  ['/settings', './settings'],
  ['/api-keys', './api-keys'],
])

for (const [from, to] of expectedRedirects) {
  assert.match(
    routerSource,
    new RegExp(`path:\\s*'${from}'.{0,180}to=\\"${to}\\"`, 's'),
    `missing legacy redirect: ${from} -> ${to}`,
  )
}

for (const [path, modulePath] of retiredRouteModules) {
  assert.equal(
    routerSource.includes(`import('${modulePath}')`),
    false,
    `retired route still lazy-loads ${modulePath}: ${path}`,
  )
}

const protectedRouteSource = routerSource.slice(
  routerSource.indexOf('<RequireAuth>'),
)
assert.equal(
  protectedRouteSource.includes('temporaryRoutes'),
  false,
  'temporary consumer routes must not remain',
)

for (const source of [layoutSource, layoutItemSource]) {
  assert.equal(source.includes('@dnd-kit'), false, 'dnd-kit import remains')
  assert.equal(
    source.includes('useNavMenuOrder'),
    false,
    'menu-order hook remains',
  )
  assert.equal(
    source.includes('menu_order'),
    false,
    'menu-order persistence remains',
  )
  assert.equal(
    source.includes('sortable'),
    false,
    'sortable UI behavior remains',
  )
}

assert.equal(
  existsSync(resolve(rootDir, 'src/pages/_layout/hooks/use-nav-menu-order.ts')),
  false,
  'obsolete menu-order hook remains',
)
// 2026-08-21 bottom-tab-bar redesign: the rail and collapse UI are gone;
// collapse_navbar remains a supported model key for compatibility only.
for (const [sourceName, source] of [
  ['layout', layoutSource],
  ['layout styles', layoutStylesSource],
  ['layout item', layoutItemSource],
]) {
  for (const obsoleteToken of [
    'collapse_navbar',
    'layout--nav-collapsed',
    'layout-content__left',
    'the-logo',
    'the-rail-footer',
    'the-nav-toggle',
  ]) {
    assert.equal(
      source.includes(obsoleteToken),
      false,
      `${sourceName} retains obsolete rail/collapse UI: ${obsoleteToken}`,
    )
  }
}
assert.equal(layoutSource.includes('<IconButton'), false)
assert.equal(layoutSource.includes('patchVerge'), false)
assert.match(
  vergeTypesSource,
  /collapse_navbar\?:\s*boolean/,
  'collapse_navbar model support must remain declared',
)
assert.equal(layoutSource.includes('LogsPage'), false, 'Logs KeepAlive remains')
assert.equal(
  mineSource.includes("navigate('/settings')"),
  false,
  'Mine still links to Settings',
)

for (const path of ['/home', '/proxies', '/rules', '/settings']) {
  assert.equal(
    appDataProviderSource.includes(`'${path}'`),
    false,
    `retired advanced route remains in AppDataProvider: ${path}`,
  )
}
for (const path of ['/promo-code', '/announcements']) {
  assert.equal(
    routerSource.includes(`import('./${path.slice(1)}')`),
    false,
    `legacy redirect must not lazy-load: ${path}`,
  )
}

assert.equal(
  plansSource.includes('https://xxlink.net/dashboard/recharge'),
  true,
  'Plans must keep dashboard recharge navigation',
)
assert.equal(
  plansSource.includes('/payment/subscription/checkout'),
  false,
  'Plans must not restore direct checkout',
)

console.log('consumer navigation validation passed')
