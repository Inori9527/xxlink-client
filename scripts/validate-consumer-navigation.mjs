import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const readSource = (relativePath) =>
  readFileSync(resolve(rootDir, relativePath), 'utf8')

const routerSource = readSource('src/pages/_routers.tsx')
const layoutSource = readSource('src/pages/_layout.tsx')
const layoutItemSource = readSource('src/components/layout/layout-item.tsx')
const appDataProviderSource = readSource('src/providers/app-data-provider.tsx')
const mineSource = readSource('src/pages/mine.tsx')
const plansSource = readSource('src/pages/plans.tsx')

const expectedNavPaths = ['/connect', '/nodes', '/plans', '/mine']
const navItemsSource = routerSource
  .split('export const navItems = [', 2)[1]
  .split('const temporaryRoutes', 2)[0]
const navPathMatches = [...navItemsSource.matchAll(/path:\s*'([^']+)'/g)].map(
  ([, path]) => path,
)

assert.deepEqual(navPathMatches, expectedNavPaths, 'consumer nav order changed')

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

for (const path of ['/promo-code', '/announcements']) {
  assert.match(
    routerSource,
    new RegExp(`path:\\s*'${path}'.{0,180}import\\(`, 's'),
    `temporary route must remain active: ${path}`,
  )
}

const protectedRouteSource = routerSource.slice(
  routerSource.indexOf('<RequireAuth>'),
)
assert.match(
  protectedRouteSource,
  /children:\s*\[[\s\S]*?\.\.\.temporaryRoutes/,
  'temporary routes must remain inside the protected route children',
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
assert.equal(
  layoutSource.includes('collapse_navbar'),
  true,
  'collapse_navbar must remain supported',
)
assert.equal(
  layoutSource.includes('patchVerge({ collapse_navbar:'),
  true,
  'collapse_navbar must remain writable',
)
assert.match(
  layoutSource,
  /<IconButton[\s\S]{0,300}data-tauri-drag-region="false"/,
  'collapse button must not be part of the Tauri drag region',
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
    appDataProviderSource.includes(`'${path}'`),
    false,
    `temporary route behavior must remain unchanged: ${path}`,
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
