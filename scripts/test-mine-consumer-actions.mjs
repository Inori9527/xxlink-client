import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..')

const readSource = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), 'utf8')

const listSourceFiles = (relativePath) =>
  readdirSync(resolve(repoRoot, relativePath), { withFileTypes: true }).flatMap(
    (entry) => {
      const entryPath = `${relativePath}/${entry.name}`
      if (entry.isDirectory()) return listSourceFiles(entryPath)
      return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : []
    },
  )

test('Mine promo panel keeps redemption, forced sync, proxy refresh, and safe errors', () => {
  const panelPath = 'src/components/mine/promo-redeem-panel.tsx'
  assert.equal(
    existsSync(resolve(repoRoot, panelPath)),
    true,
    'promo panel missing',
  )

  const source = readSource(panelPath)

  assert.match(source, /code\.trim\(\)/)
  assert.match(source, /backendController\.redeemPromo\(normalizedCode\)/)
  assert.match(source, /syncSubscription\(\{ force: true \}\)/)
  assert.match(source, /await refreshProxy\(\)/)
  assert.match(source, /reportSafeClientFailure\('promo-sync', syncError\)/)
  assert.match(source, /reportSafeClientFailure\('promo-redeem', redeemError\)/)
  assert.match(
    source,
    /toSafeClientErrorMessage\(classifyClientError\(redeemError\)\.kind, t\)/,
  )
  assert.match(source, /syncWarning/)
  assert.match(source, /retrySync/)
  assert.doesNotMatch(source, /\b(?:syncError|redeemError)\.message/)
  assert.doesNotMatch(
    source,
    /console\.(?:warn|error)\s*\([^)]*\b(?:syncError|redeemError)\b/,
  )
})

test('Mine copies the redacted diagnostics bundle with localized safe feedback', () => {
  const source = readSource('src/pages/mine.tsx')

  assert.match(source, /runtimeActionController\.copyDiagnostics\(\)/)
  assert.match(
    source,
    /reportSafeClientFailure\('mine-copy-diagnostics', error\)/,
  )
  assert.match(
    source,
    /toSafeClientErrorMessage\(classifyClientError\(error\)\.kind, t\)/,
  )
  assert.match(source, /showNotice\.success\(text\.diagnosticsCopied\)/)
  assert.match(source, /showNotice\.error\(\s*toSafeClientErrorMessage/)
  assert.doesNotMatch(source, /\berror\.message/)
  assert.doesNotMatch(source, /console\.(?:warn|error)\s*\([^)]*\berror\b/)

  for (const localePath of [
    'src/locales/en/mine.json',
    'src/locales/zh/mine.json',
  ]) {
    const locale = JSON.parse(readSource(localePath))
    assert.equal(typeof locale.rows.diagnostics.title, 'string')
    assert.equal(typeof locale.rows.diagnostics.description, 'string')
    assert.equal(typeof locale.diagnostics.copied, 'string')
  }
})

test('Mine no longer contains announcement API usage or navigation', () => {
  const source = readSource('src/pages/mine.tsx')

  assert.equal(source.includes('api.announcements'), false)
  assert.equal(source.includes('/announcements'), false)
  assert.equal(source.includes('normalizeAnnouncementLevel'), false)
  assert.equal(source.includes('Announcement'), false)
})

// 2026-08-21: Mine now owns the consumer-facing connection mode settings row.
test('Mine keeps the relocated connection mode control and bilingual copy', () => {
  const source = readSource('src/pages/mine.tsx')

  assert.match(source, /useConnectModeControl/)
  assert.match(source, /modeControl\.handleModeChange/)
  assert.match(source, /modeControl\.serviceInstallMode/)

  for (const localePath of [
    'src/locales/en/mine.json',
    'src/locales/zh/mine.json',
  ]) {
    const locale = JSON.parse(readSource(localePath))
    assert.equal(typeof locale.sections.settings, 'string')
    assert.equal(typeof locale.rows.connectMode.title, 'string')
    assert.equal(typeof locale.rows.connectMode.description, 'string')
  }
})

test('protected layout has no announcement prompt or fetch-display path', () => {
  const layoutSource = readSource('src/pages/_layout.tsx')

  assert.equal(layoutSource.includes('AnnouncementPrompt'), false)
  assert.equal(layoutSource.includes('announcement-prompt'), false)
  assert.equal(
    existsSync(
      resolve(repoRoot, 'src/components/layout/announcement-prompt.tsx'),
    ),
    false,
  )

  for (const sourcePath of [
    ...listSourceFiles('src/pages'),
    ...listSourceFiles('src/components/layout'),
  ]) {
    const source = readSource(sourcePath)
    assert.equal(
      source.includes('api.announcements'),
      false,
      `${sourcePath} retains an announcement API fetch`,
    )
    assert.equal(
      source.includes('AnnouncementPrompt'),
      false,
      `${sourcePath} retains announcement prompt display`,
    )
  }
})

test('legacy promo and announcement routes redirect to Mine without lazy modules', () => {
  const routerSource = readSource('src/pages/_routers.tsx')

  assert.equal(routerSource.includes('temporaryRoutes'), false)
  assert.equal(routerSource.includes("import('./promo-code')"), false)
  assert.equal(routerSource.includes("import('./announcement-center')"), false)

  for (const path of ['/promo-code', '/announcements']) {
    assert.match(
      routerSource,
      new RegExp(`path:\\s*'${path}'.{0,180}to=\\"/mine\\"`, 's'),
    )
  }

  assert.equal(existsSync(resolve(repoRoot, 'src/pages/promo-code.tsx')), false)
  assert.equal(
    existsSync(resolve(repoRoot, 'src/pages/announcement-center.tsx')),
    false,
  )
})

test('consumer routes retain only public auth and the four real consumer destinations', () => {
  const routerSource = readSource('src/pages/_routers.tsx')
  const navSource = routerSource
    .split('export const navItems = [', 2)[1]
    .split('const redirectRoutes', 2)[0]
  const navPaths = [...navSource.matchAll(/path:\s*'([^']+)'/g)].map(
    ([, path]) => path,
  )

  assert.deepEqual(navPaths, ['/connect', '/nodes', '/plans', '/mine'])
  assert.match(routerSource, /path: '\/login'/)
  assert.match(routerSource, /path: '\/register'/)
  assert.equal(routerSource.includes('/payment/subscription/checkout'), false)
})
