import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'

// PROVES:         Part executed, part source text. That the checked-in inputs hold the
//                 reviewed values -- tauri.conf.json and the per-platform
//                 tauri.<platform>.conf.json files, package.json, src/main.tsx and one
//                 GitHub workflow file, so source and workflow text as well as data --
//                 plus that this file's own inline helpers reject its negative fixtures.
// DOES NOT PROVE: That any application, build, or Tauri code works.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tauriRoot = path.join(root, 'src-tauri')
const configPath = path.join(tauriRoot, 'tauri.conf.json')
const mainPath = path.join(root, 'src', 'main.tsx')
const packagePath = path.join(root, 'package.json')
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const mainSource = fs.readFileSync(mainPath, 'utf8')
const packageConfig = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
const security = config.app?.security
const reviewedBuild = {
  beforeBuildCommand: 'corepack pnpm run web:build',
  frontendDist: '../dist',
  beforeDevCommand: 'corepack pnpm run web:dev',
  devUrl: 'http://localhost:3000/',
  removeUnusedCommands: true,
}

const parseArguments = (args) => {
  let platform

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === '--platform') {
      platform = args[index + 1]
      assert.ok(platform, '--platform requires a value')
      index += 1
      continue
    }

    assert.fail(`unsupported CSP validator argument: ${argument}`)
  }

  return { platform }
}

const runtimePlatform =
  process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos'
      : process.platform
const requestedInputs = parseArguments(process.argv.slice(2))
const requestedPlatform = requestedInputs.platform ?? runtimePlatform

assert.equal(
  typeof security?.csp,
  'string',
  'production CSP must be configured',
)
assert.equal(
  typeof security?.devCsp,
  'string',
  'development CSP must be configured separately',
)

const parsePolicy = (policy) => {
  const directives = new Map()

  for (const rawDirective of policy.split(';')) {
    const directive = rawDirective.trim()
    assert.notEqual(directive, '', 'CSP must not contain empty directives')
    const [rawName, ...sources] = directive.split(/\s+/u)
    const name = rawName.toLowerCase()
    assert.ok(!directives.has(name), `CSP must not repeat ${name}`)
    directives.set(name, sources)
  }

  return directives
}

assert.throws(
  () => parsePolicy("script-src https:; script-src 'self'"),
  /must not repeat script-src/u,
  'duplicate directives must fail closed because browsers honor the first',
)
assert.throws(
  () => parsePolicy("SCRIPT-SRC https:; script-src 'self'"),
  /must not repeat script-src/u,
  'directive names must be normalized before duplicate detection',
)
assert.throws(
  () => parsePolicy("script-src 'self';; object-src 'none'"),
  /must not contain empty directives/u,
  'empty directives must not be silently normalized',
)

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const mergePatch = (target, patch) => {
  if (!isRecord(patch)) return patch

  const result = isRecord(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key]
    } else {
      result[key] = mergePatch(result[key], value)
    }
  }
  return result
}

const production = parsePolicy(security.csp)
const development = parsePolicy(security.devCsp)
const reviewedProductionDirectives = [
  'base-uri',
  'connect-src',
  'default-src',
  'font-src',
  'form-action',
  'frame-ancestors',
  'frame-src',
  'img-src',
  'media-src',
  'object-src',
  'script-src',
  'style-src',
  'style-src-attr',
  'worker-src',
]

const assertReviewedProductionDirectives = (policy) => {
  assert.deepEqual(
    [...policy.keys()].sort(),
    reviewedProductionDirectives,
    'production CSP must contain only reviewed directives',
  )
}

assertReviewedProductionDirectives(production)
assert.throws(
  () =>
    assertReviewedProductionDirectives(
      parsePolicy(`${security.csp}; script-src-elem https://evil.invalid`),
    ),
  /must contain only reviewed directives/u,
  'element-specific script directives must not bypass the reviewed policy',
)

const assertReviewedDevelopmentDirectives = (policy) => {
  assert.deepEqual(
    [...policy.keys()].sort(),
    reviewedProductionDirectives,
    'development CSP must contain only reviewed directives',
  )
}

assertReviewedDevelopmentDirectives(development)
assert.throws(
  () =>
    assertReviewedDevelopmentDirectives(
      parsePolicy(`${security.devCsp}; script-src-elem https:`),
    ),
  /must contain only reviewed directives/u,
  'development element-specific directives must not bypass the reviewed policy',
)

const isAssetCspModificationDisabled = (effectiveSecurity, directive) => {
  const setting =
    effectiveSecurity.dangerousDisableAssetCspModification ?? false
  assert.ok(
    typeof setting === 'boolean' || Array.isArray(setting),
    'Tauri CSP modification setting must use a supported shape',
  )
  return (
    setting === true || (Array.isArray(setting) && setting.includes(directive))
  )
}

const validateEffectiveConfig = (
  name,
  effectiveConfig,
  reviewedSecurity,
  isLegacyWebKitCompatibility,
) => {
  assert.deepEqual(
    effectiveConfig.build,
    reviewedBuild,
    `${name} must retain the complete reviewed frontend build configuration`,
  )
  const effectiveSecurity = effectiveConfig.app?.security
  assert.ok(
    isRecord(effectiveSecurity),
    `${name} must retain the reviewed security configuration`,
  )
  assert.deepEqual(
    effectiveSecurity,
    reviewedSecurity,
    `${name} must not override the reviewed app security configuration`,
  )
  assert.deepEqual(
    parsePolicy(effectiveSecurity.csp),
    production,
    `${name} must not override the reviewed production CSP`,
  )
  assert.deepEqual(
    parsePolicy(effectiveSecurity.devCsp),
    development,
    `${name} must not override the reviewed development CSP`,
  )
  assert.equal(
    isAssetCspModificationDisabled(effectiveSecurity, 'script-src'),
    false,
    `${name} must not disable script nonce/hash modification`,
  )
  assert.equal(
    isAssetCspModificationDisabled(effectiveSecurity, 'style-src'),
    isLegacyWebKitCompatibility,
    `${name} has an unexpected style nonce modification policy`,
  )

  if (isLegacyWebKitCompatibility) {
    assert.ok(
      parsePolicy(effectiveSecurity.csp)
        .get('style-src')
        ?.includes("'unsafe-inline'"),
      'macOS 11 compatibility requires inline styles when old WebKit lacks style-src-attr',
    )
  }
}

const requiredPlatformConfigNames = [
  'tauri.linux.conf.json',
  'tauri.macos.conf.json',
  'tauri.windows.conf.json',
]

const assertRequiredPlatformConfigs = (names) => {
  for (const requiredName of requiredPlatformConfigNames) {
    assert.ok(
      names.includes(requiredName),
      `required reviewed platform configuration is missing: ${requiredName}`,
    )
  }
}

const platformTargets = fs
  .readdirSync(tauriRoot)
  .filter((name) => /^tauri\.[^.]+\.conf\.json$/u.test(name))
  .map((name) => ({
    name,
    effectiveConfig: mergePatch(
      config,
      JSON.parse(fs.readFileSync(path.join(tauriRoot, name), 'utf8')),
    ),
    isLegacyWebKitCompatibility: name === 'tauri.macos.conf.json',
    reviewedSecurity:
      name === 'tauri.macos.conf.json'
        ? mergePatch(config.app.security, {
            dangerousDisableAssetCspModification: ['style-src'],
          })
        : config.app.security,
  }))

const platformTargetNames = platformTargets.map((target) => target.name)
assertRequiredPlatformConfigs(platformTargetNames)
assert.throws(
  () =>
    assertRequiredPlatformConfigs(
      platformTargetNames.filter((name) => name !== 'tauri.macos.conf.json'),
    ),
  /required reviewed platform configuration is missing/u,
  'missing platform configuration must fail closed',
)

const configTargets = [
  {
    name: 'tauri.conf.json',
    effectiveConfig: config,
    isLegacyWebKitCompatibility: false,
    reviewedSecurity: config.app.security,
  },
  ...platformTargets,
]

for (const target of configTargets) {
  validateEffectiveConfig(
    target.name,
    target.effectiveConfig,
    target.reviewedSecurity,
    target.isLegacyWebKitCompatibility,
  )
}

assert.ok(
  ['windows', 'macos', 'linux'].includes(requestedPlatform),
  'requested platform must be a reviewed desktop platform',
)

const selectedTarget = platformTargets.find(
  (target) => target.name === `tauri.${requestedPlatform}.conf.json`,
)

assert.ok(
  selectedTarget,
  `no reviewed Tauri platform configuration exists for ${requestedPlatform}`,
)

const cumulativeFixture = mergePatch(
  mergePatch(config, { bundle: { active: false } }),
  { bundle: { active: true } },
)
assert.equal(
  cumulativeFixture.bundle?.active,
  true,
  'ordered build overlays must be merged cumulatively',
)

assert.throws(
  () =>
    validateEffectiveConfig(
      'security deletion fixture',
      mergePatch(config, { app: { security: null } }),
      config.app.security,
      false,
    ),
  /must retain the reviewed security configuration/u,
  'RFC 7396 security deletion must fail closed',
)
assert.throws(
  () =>
    validateEffectiveConfig(
      'build deletion fixture',
      mergePatch(config, { build: null }),
      config.app.security,
      false,
    ),
  /must retain the complete reviewed frontend build configuration/u,
  'RFC 7396 build deletion must fail closed',
)
assert.throws(
  () =>
    validateEffectiveConfig(
      'frontend directory fixture',
      mergePatch(config, { build: { frontendDist: '../unreviewed-dist' } }),
      config.app.security,
      false,
    ),
  /must retain the complete reviewed frontend build configuration/u,
  'an alternate frontend directory must fail closed',
)
assert.throws(
  () =>
    validateEffectiveConfig(
      'bundle hook fixture',
      mergePatch(config, {
        build: { beforeBundleCommand: 'unreviewed-command' },
      }),
      config.app.security,
      false,
    ),
  /must retain the complete reviewed frontend build configuration/u,
  'an unreviewed bundle hook must fail closed',
)
assert.throws(
  () =>
    validateEffectiveConfig(
      'development CSP fixture',
      mergePatch(config, {
        app: {
          security: {
            devCsp: "default-src *; script-src 'unsafe-eval'",
          },
        },
      }),
      config.app.security,
      false,
    ),
  /must not override the reviewed app security configuration/u,
  'a weakened platform development CSP must fail closed',
)

const expectDirective = (policy, name, expected) => {
  assert.deepEqual(
    policy.get(name),
    expected,
    `${name} must stay least-privilege`,
  )
}

expectDirective(production, 'default-src', ["'self'"])
expectDirective(production, 'base-uri', ["'none'"])
expectDirective(production, 'connect-src', ["'self'", 'https://api.xxlink.net'])
expectDirective(production, 'font-src', ["'self'", 'data:'])
expectDirective(production, 'form-action', ["'none'"])
expectDirective(production, 'frame-ancestors', ["'none'"])
expectDirective(production, 'frame-src', ["'none'"])
expectDirective(production, 'img-src', ["'self'", 'data:'])
expectDirective(production, 'media-src', ["'none'"])
expectDirective(production, 'object-src', ["'none'"])
expectDirective(production, 'script-src', ["'self'"])
expectDirective(production, 'style-src', ["'self'", "'unsafe-inline'"])
expectDirective(production, 'style-src-attr', ["'unsafe-inline'"])
expectDirective(production, 'worker-src', ["'self'"])
expectDirective(development, 'default-src', ["'self'", 'http://localhost:3000'])
expectDirective(development, 'base-uri', ["'none'"])
expectDirective(development, 'connect-src', [
  "'self'",
  'http://localhost:3000',
  'ws://localhost:3000',
  'https://api.xxlink.net',
])
expectDirective(development, 'font-src', ["'self'", 'data:'])
expectDirective(development, 'form-action', ["'none'"])
expectDirective(development, 'frame-ancestors', ["'none'"])
expectDirective(development, 'frame-src', ["'none'"])
expectDirective(development, 'img-src', ["'self'", 'data:'])
expectDirective(development, 'media-src', ["'none'"])
expectDirective(development, 'object-src', ["'none'"])
expectDirective(development, 'script-src', [
  "'self'",
  'http://localhost:3000',
  "'unsafe-inline'",
  "'unsafe-eval'",
])
expectDirective(development, 'style-src', [
  "'self'",
  'http://localhost:3000',
  "'unsafe-inline'",
])
expectDirective(development, 'style-src-attr', ["'unsafe-inline'"])
expectDirective(development, 'worker-src', [
  "'self'",
  'http://localhost:3000',
  'blob:',
])

assert.match(
  mainSource,
  /querySelector<HTMLElement>\(\s*['"]style\[nonce\], script\[nonce\]['"],?\s*\)/u,
  'Emotion must discover the style nonce injected into packaged Tauri HTML',
)
assert.match(
  mainSource,
  /return nonceElement\?\.nonce \|\| undefined/u,
  'Emotion must read the nonce DOM property because getAttribute is nonce-hidden',
)
assert.match(
  mainSource,
  /createCache\(\{[\s\S]*?nonce:\s*getCspNonce\(\)/u,
  'Emotion must attach the packaged Tauri nonce to runtime style elements',
)
const expectedGuardedScripts = {
  build:
    "cross-env NODE_OPTIONS='--max-old-space-size=4096' node scripts/tauri-cli.mjs build",
  'build:fast':
    "cross-env NODE_OPTIONS='--max-old-space-size=4096' node scripts/tauri-cli.mjs build -- --profile fast-release",
  'build:win-x64':
    'pnpm prebuild:win-x64 && node scripts/tauri-cli.mjs build --target x86_64-pc-windows-gnu',
  tauri: 'node scripts/tauri-cli.mjs',
  'web:build':
    'node --test scripts/test-tauri-cli-arguments.mjs && node scripts/validate-csp-policy.mjs && tsc --noEmit && vite build',
}

for (const [scriptName, expectedCommand] of Object.entries(
  expectedGuardedScripts,
)) {
  assert.equal(
    packageConfig.scripts?.[scriptName],
    expectedCommand,
    `${scriptName} must exactly retain the reviewed Tauri build route`,
  )
}

const workflowExpectations = [
  {
    path: '.github/workflows/dev.yml',
    actionArgs: ['--target ${{ matrix.target }} -b ${{ matrix.bundle }}'],
    directTargetBuildCount: 0,
  },
  {
    path: '.github/workflows/autobuild.yml',
    actionArgs: [
      '--target ${{ matrix.target }}',
      '--target ${{ matrix.target }}',
    ],
    directTargetBuildCount: 1,
  },
  {
    path: '.github/workflows/release.yml',
    actionArgs: [
      '--target ${{ matrix.target }}',
      '--target ${{ matrix.target }}',
    ],
    directTargetBuildCount: 1,
  },
]

for (const expectation of workflowExpectations) {
  const workflowPath = expectation.path
  const workflowSource = fs.readFileSync(path.join(root, workflowPath), 'utf8')
  const workflow = parseYaml(workflowSource)
  const steps = Object.values(workflow.jobs ?? {}).flatMap(
    (job) => job.steps ?? [],
  )
  const tauriActionSteps = steps.filter(
    (step) =>
      typeof step.uses === 'string' &&
      step.uses.startsWith('tauri-apps/tauri-action@'),
  )

  assert.deepEqual(
    tauriActionSteps.map((step) => step.with?.tauriScript),
    expectation.actionArgs.map(() => 'pnpm tauri'),
    `${workflowPath} must route every tauri-action build through pnpm tauri`,
  )
  assert.deepEqual(
    tauriActionSteps.map((step) => step.with?.args),
    expectation.actionArgs,
    `${workflowPath} must preserve every reviewed Tauri target and bundle argument`,
  )
  assert.ok(
    tauriActionSteps.every(
      (step) => !String(step.with?.args ?? '').includes('--config'),
    ),
    `${workflowPath} must not pass dynamic configuration to tauri-action`,
  )

  const targetBuildLines = steps
    .flatMap((step) =>
      typeof step.run === 'string' ? step.run.split(/\r?\n/u) : [],
    )
    .map((line) => line.trim())
    .filter(
      (line) =>
        !line.startsWith('#') &&
        line.includes('build') &&
        line.includes('--target ${{ matrix.target }}'),
    )

  assert.deepEqual(
    targetBuildLines,
    Array.from(
      { length: expectation.directTargetBuildCount },
      () => 'node scripts/tauri-cli.mjs build --target ${{ matrix.target }}',
    ),
    `${workflowPath} must preserve every reviewed direct target build`,
  )
}

const productionSources = [...production.values()].flat()

for (const forbidden of [
  "'unsafe-eval'",
  '*',
  'http:',
  'https:',
  'ws:',
  'wss:',
]) {
  assert.ok(
    !productionSources.includes(forbidden),
    `production CSP must not contain ${forbidden}`,
  )
}

for (const developmentOnlySource of [
  'http://localhost:3000',
  'ws://localhost:3000',
]) {
  assert.ok(
    !productionSources.includes(developmentOnlySource),
    `production CSP must not contain ${developmentOnlySource}`,
  )
}

assert.ok(
  security.devCsp.includes('http://localhost:3000'),
  'development CSP must allow the exact Vite origin',
)
assert.ok(
  security.devCsp.includes('ws://localhost:3000'),
  'development CSP must allow the exact Vite HMR socket',
)
assert.ok(
  !security.devCsp.includes('*'),
  'development CSP must not use wildcard sources',
)

for (const externalNavigation of [
  'https://xxlink.net/dashboard/recharge',
  'https://xxlink.net/download',
]) {
  assert.ok(
    !security.csp.includes(externalNavigation),
    'external shell navigation must not broaden WebView CSP',
  )
}

console.log('CSP policy validation passed')
