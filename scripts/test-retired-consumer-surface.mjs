import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, posix, relative, resolve } from 'node:path'
import test from 'node:test'

// PROVES:         Source text only. A green run proves two filesystem facts and nothing
//                 more.
// DOES NOT PROVE: Anything about behaviour.

const repoRoot = resolve(import.meta.dirname, '..')
const sourceRoot = resolve(repoRoot, 'src')

const retiredPaths = [
  'src/pages/home.tsx',
  'src/pages/profiles.tsx',
  'src/pages/proxies.tsx',
  'src/pages/connections.tsx',
  'src/pages/rules.tsx',
  'src/pages/unlock.tsx',
  'src/pages/settings.tsx',
  'src/pages/logs.tsx',
  'src/pages/api-keys.tsx',
  'src/components/home',
  'src/components/connection',
  'src/components/rule',
  'src/components/proxy',
  'src/components/profile',
  'src/components/setting/setting-clash.tsx',
  'src/components/setting/setting-system.tsx',
  'src/components/setting/setting-verge-advanced.tsx',
  'src/components/setting/setting-verge-basic.tsx',
  'src/components/setting/mods/clash-port-viewer.tsx',
  'src/components/setting/mods/config-viewer.tsx',
  'src/components/setting/mods/controller-viewer.tsx',
  'src/components/setting/mods/dns-viewer.tsx',
  'src/components/setting/mods/guard-state.tsx',
  'src/components/setting/mods/lite-mode-viewer.tsx',
  'src/components/setting/mods/misc-viewer.tsx',
  'src/components/setting/mods/network-interface-viewer.tsx',
  'src/components/setting/mods/password-input.tsx',
  'src/components/setting/mods/setting-comp.tsx',
  'src/components/setting/mods/theme-mode-switch.tsx',
  'src/services/monaco.ts',
  'src/utils/yaml.worker.ts',
  'src/components/shared/proxy-control-switches.tsx',
  'src/hooks/use-connection-data.ts',
  'src/hooks/use-connection-setting.ts',
  'src/hooks/use-current-proxy.ts',
  'src/hooks/use-log-data.ts',
  'src/hooks/use-profiles.ts',
]

const retainedPaths = [
  'src/pages/connect.tsx',
  'src/pages/nodes.tsx',
  'src/pages/plans.tsx',
  'src/pages/mine.tsx',
  'src/components/setting/mods/stack-mode-switch.tsx',
  'src/components/setting/mods/sysproxy-viewer.tsx',
  'src/components/setting/mods/tun-viewer.tsx',
  'src/components/setting/mods/update-viewer.tsx',
  'src/hooks/use-proxy-selection.ts',
  'src/hooks/use-system-state.ts',
  'src/services/managed-subscription-profile.ts',
  'src/services/subscription-auto-sync.ts',
  'src/services/subscription-sync.ts',
  'src-tauri/src/utils/resolve/scheme.rs',
]

const redirectTargets = new Map([
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

const retiredImportRoots = retiredPaths.map((entry) =>
  entry.replace(/\.(?:ts|tsx)$/, ''),
)

const listSourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) return listSourceFiles(entryPath)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : []
  })

const sourceImportSpecifiers = (source) => {
  const specifiers = []
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'"`]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ]

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1])
    }
  }

  return specifiers
}

const resolveImportPath = (sourcePath, specifier) => {
  const sourceRelativePath = relative(sourceRoot, sourcePath).replaceAll(
    '\\',
    '/',
  )
  const withoutQuery = specifier.split(/[?#]/, 1)[0]
  const importedPath = withoutQuery.startsWith('@/')
    ? `src/${withoutQuery.slice(2)}`
    : withoutQuery.startsWith('.')
      ? posix.join('src', posix.dirname(sourceRelativePath), withoutQuery)
      : null

  return importedPath?.replace(/\.(?:ts|tsx)$/, '')
}

test('retired consumer pages, component trees, and hooks are absent', () => {
  for (const relativePath of retiredPaths) {
    assert.equal(
      existsSync(resolve(repoRoot, relativePath)),
      false,
      `${relativePath} must be removed`,
    )
  }
})

test('legacy routes remain redirects while retained consumer controls remain available', () => {
  const routerSource = readFileSync(
    resolve(repoRoot, 'src/pages/_routers.tsx'),
    'utf8',
  )

  for (const [legacyPath, targetPath] of redirectTargets) {
    assert.match(
      routerSource,
      new RegExp(`path:\\s*'${legacyPath}'.{0,180}to=\\"${targetPath}\\"`, 's'),
    )
  }

  for (const relativePath of retainedPaths) {
    assert.equal(
      existsSync(resolve(repoRoot, relativePath)),
      true,
      `${relativePath} must remain`,
    )
  }
})

test('source imports do not reference the retired consumer surface', () => {
  for (const sourcePath of listSourceFiles(sourceRoot)) {
    const source = readFileSync(sourcePath, 'utf8')
    for (const specifier of sourceImportSpecifiers(source)) {
      const importedPath = resolveImportPath(sourcePath, specifier)
      assert.equal(
        retiredImportRoots.some(
          (retiredRoot) =>
            importedPath === retiredRoot ||
            importedPath?.startsWith(`${retiredRoot}/`),
        ),
        false,
        `${relative(repoRoot, sourcePath)} imports retired ${specifier}`,
      )
      assert.doesNotMatch(
        specifier,
        /(?:^|\/)monaco(?:-yaml|-editor)?(?:\/|$)|@monaco-editor\/react/,
        `${relative(repoRoot, sourcePath)} retains Monaco import ${specifier}`,
      )
    }
  }
})

test('consumer TUN and update controls remain without PAC or raw-error editors', () => {
  const sysproxySource = readFileSync(
    resolve(repoRoot, 'src/components/setting/mods/sysproxy-viewer.tsx'),
    'utf8',
  )
  const tunSource = readFileSync(
    resolve(repoRoot, 'src/components/setting/mods/tun-viewer.tsx'),
    'utf8',
  )
  const connectSource = readFileSync(
    resolve(repoRoot, 'src/pages/connect.tsx'),
    'utf8',
  )
  // 2026-08-21: the sanctioned mode/install flow is shared by Connect and Mine.
  const modeControlSource = readFileSync(
    resolve(repoRoot, 'src/hooks/use-connect-mode-control.ts'),
    'utf8',
  )
  const mineSource = readFileSync(
    resolve(repoRoot, 'src/pages/mine.tsx'),
    'utf8',
  )

  assert.doesNotMatch(connectSource, /ProxyControlSwitches/)
  assert.doesNotMatch(connectSource, /handleProxyControlError/)
  assert.match(modeControlSource, /useServiceInstaller/)
  assert.match(modeControlSource, /await installServiceAndRestartCore\(\)/)
  assert.match(modeControlSource, /isTunModeAvailable !== true/)
  assert.match(modeControlSource, /setPendingMode\(next\)/)
  assert.match(tunSource, /StackModeSwitch/)
  assert.match(mineSource, /UpdateViewer/)

  assert.doesNotMatch(sysproxySource, /EditorViewer|EditRounded/)
  assert.doesNotMatch(
    sysproxySource,
    /editorOpen|pacEditor|openPacEditor|handleSavePac|editPac|pacScriptContent/,
  )
  assert.doesNotMatch(
    sysproxySource,
    /showNotice\.error\(\s*(?:err|error)\s*\)/,
  )
  assert.doesNotMatch(
    sysproxySource,
    /console\.(?:warn|error)\s*\([^)]*\b(?:err|error)\b/,
  )
  assert.match(sysproxySource, /proxy_auto_config/)
  assert.doesNotMatch(sysproxySource, /pac_file_content|pac_content/)
  assert.match(
    sysproxySource,
    /runtimeActionController\.refreshSystemProxy\(\)/,
  )
  assert.doesNotMatch(
    sysproxySource,
    /setSystemProxyEnabled\(false\)[\s\S]{0,500}setSystemProxyEnabled\(true\)/,
  )
  assert.match(sysproxySource, /reportSafeClientFailure/)
  assert.match(sysproxySource, /toSafeClientErrorMessage/)
})

test('managed sync startup and redacted subscription deep links remain wired', () => {
  const mainSource = readFileSync(resolve(repoRoot, 'src/main.tsx'), 'utf8')
  const syncSource = readFileSync(
    resolve(repoRoot, 'src/services/subscription-sync.ts'),
    'utf8',
  )
  const libSource = readFileSync(
    resolve(repoRoot, 'src-tauri/src/lib.rs'),
    'utf8',
  )
  const resolverSource = readFileSync(
    resolve(repoRoot, 'src-tauri/src/utils/resolve/scheme.rs'),
    'utf8',
  )

  assert.match(mainSource, /startSubscriptionAutoSync\(\)/)
  assert.match(syncSource, /refreshManagedSubscriptionProfile\(\)/)
  assert.match(syncSource, /rebuildManagedSubscriptionProfile\(\)/)
  assert.match(libSource, /tauri_plugin_deep_link::init\(\)/)
  assert.match(libSource, /app\.deep_link\(\)\.on_open_url/)
  assert.match(resolverSource, /redacted_deep_link_for_log\(param\)/)
  assert.match(resolverSource, /post_import_updates/)
})

test('Plans sends purchases to dashboard recharge rather than direct checkout', () => {
  const plansSource = readFileSync(
    resolve(repoRoot, 'src/pages/plans.tsx'),
    'utf8',
  )

  assert.match(plansSource, /https:\/\/xxlink\.net\/dashboard\/recharge/)
  assert.equal(plansSource.includes('/payment/subscription/checkout'), false)
  assert.doesNotMatch(plansSource, /createCheckout|checkoutUrl/)
  assert.match(
    plansSource,
    /reportSafeClientFailure\('plans-claim-public-benefit'/,
  )
  assert.doesNotMatch(plansSource, /claimError\.message/)
})

test('active consumer pages do not expose raw operation errors', () => {
  const connectSource = readFileSync(
    resolve(repoRoot, 'src/pages/connect.tsx'),
    'utf8',
  )

  assert.doesNotMatch(connectSource, /console\.(?:error|warn)\(/)
  assert.doesNotMatch(
    connectSource,
    /showNotice\.error\([^)]*,\s*(?:error|rollbackError)\b/,
  )
  assert.match(connectSource, /reportSafeClientFailure\('connect-toggle'/)
  assert.match(connectSource, /reportSafeClientFailure\('connect-refresh'/)
})

// 2026-08-21: node selection and guarded recommendation now live in the
// shared catalog consumed by Connect and Nodes.
test('manual node selection persists and guarded automatic selection is shared', () => {
  const connectSource = readFileSync(
    resolve(repoRoot, 'src/pages/connect.tsx'),
    'utf8',
  )
  const nodesSource = readFileSync(
    resolve(repoRoot, 'src/pages/nodes.tsx'),
    'utf8',
  )
  const catalogSource = readFileSync(
    resolve(repoRoot, 'src/hooks/use-node-catalog.ts'),
    'utf8',
  )

  assert.match(connectSource, /useNodeCatalog/)
  assert.match(nodesSource, /useNodeCatalog/)
  assert.match(catalogSource, /changeProxy\(groupName, node\.name\)/)
  assert.match(catalogSource, /autoSelectAttemptRef/)
  assert.match(
    catalogSource,
    /selectNode\(recommendedCandidate\.node, 'auto'\)/,
  )
  assert.match(
    connectSource,
    /onSelectionError:\s*\(error\)\s*=>\s*reportSafeClientFailure\('connect-proxy-selection', error\)/,
  )
  assert.match(
    nodesSource,
    /onSelectionError:\s*\(error\)\s*=>\s*reportSafeClientFailure\('nodes-proxy-selection', error\)/,
  )
})

test('proxy selection awaits typed persistence and reports errors safely', () => {
  const selectionSource = readFileSync(
    resolve(repoRoot, 'src/hooks/use-proxy-selection.ts'),
    'utf8',
  )
  const controllerSource = readFileSync(
    resolve(repoRoot, 'src/services/runtime-action-controller.ts'),
    'utf8',
  )
  const rustControllerSource = readFileSync(
    resolve(repoRoot, 'src-tauri/src/cmd/runtime_action_controller.rs'),
    'utf8',
  )

  assert.match(selectionSource, /import \{ reportSafeClientFailure \}/)
  assert.match(selectionSource, /await runtimeActionController\.selectNode\(\{/)
  assert.match(selectionSource, /persist:\s*!skipConfigSave/)
  assert.match(
    controllerSource,
    /invoke<void>\('runtime_select_node', \{[\s\S]*groupName,[\s\S]*proxyName,[\s\S]*persist,[\s\S]*closePreviousConnections,[\s\S]*\}\)/,
  )
  assert.doesNotMatch(controllerSource, /getConnections|closeConnection/)
  assert.match(
    rustControllerSource,
    /Some\(persist_node_selection\(&group_name, &proxy_name\)\.await\?\)/,
  )
  assert.match(
    rustControllerSource,
    /profiles_replace_item_selected_safe\(&profile_id, previous_selected\)[\s\S]*\.await[\s\S]*\.is_err\(\)/,
  )
  assert.doesNotMatch(rustControllerSource, /get_proxy_by_name\(&group_name\)/)
  assert.match(
    rustControllerSource,
    /current_runtime_node\(&group_name\)\.await/,
  )
  assert.match(
    rustControllerSource,
    /schedule_previous_node_connection_cleanup\(group_name\.to_string\(\), expected_current_proxy, previous_proxy\)/,
  )
  assert.match(rustControllerSource, /static NODE_SELECTION_LOCK: Mutex<\(\)>/)
  assert.match(
    rustControllerSource,
    /pub async fn runtime_select_node[\s\S]*wait_profile_switch_guard\(\)\.await;[\s\S]*NODE_SELECTION_LOCK\.lock\(\)\.await/,
  )
  assert.doesNotMatch(
    rustControllerSource,
    /let _ = persist_node_selection\(&group_name, &proxy_name\)\.await/,
  )
  assert.doesNotMatch(
    selectionSource,
    /console\.(?:warn|error)\s*\([^)]*\b(?:error|fallbackError)\b/,
  )
})
