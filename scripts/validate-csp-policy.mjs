import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(root, 'src-tauri', 'tauri.conf.json')
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const security = config.app?.security

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

const parsePolicy = (policy) =>
  new Map(
    policy.split(';').map((rawDirective) => {
      const [name, ...sources] = rawDirective.trim().split(/\s+/u)
      return [name, sources]
    }),
  )

const production = parsePolicy(security.csp)
const development = parsePolicy(security.devCsp)

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
expectDirective(production, 'form-action', ["'none'"])
expectDirective(production, 'frame-ancestors', ["'none'"])
expectDirective(production, 'frame-src', ["'none'"])
expectDirective(production, 'media-src', ["'none'"])
expectDirective(production, 'object-src', ["'none'"])
expectDirective(production, 'script-src', ["'self'"])
expectDirective(production, 'worker-src', ["'self'"])

assert.ok(
  production.get('style-src')?.includes("'unsafe-inline'"),
  'MUI and existing React style attributes require inline styles',
)

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
