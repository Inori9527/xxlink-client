import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// PROVES:         Source text only. For each of src/locales/en and src/locales/zh: (a)
//                 the five retired namespace files connections.json, logs.json,
//                 proxies.json, rules.json, tests.json are absent from that directory
//                 (real existsSync filesystem ...
// DOES NOT PROVE: It never executes the code under test.

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const retiredNamespaces = ['connections', 'logs', 'proxies', 'rules', 'tests']
const activeNamespaces = [
  'home',
  'layout',
  'mine',
  'plans',
  'profiles',
  'settings',
  'shared',
]

for (const locale of ['en', 'zh']) {
  const localeDir = resolve(rootDir, 'src', 'locales', locale)
  const indexSource = readFileSync(resolve(localeDir, 'index.ts'), 'utf8')

  for (const namespace of retiredNamespaces) {
    assert.equal(
      existsSync(resolve(localeDir, `${namespace}.json`)),
      false,
      `${locale}/${namespace}.json must stay retired`,
    )
    assert.doesNotMatch(
      indexSource,
      new RegExp(
        `(?:import\\s+${namespace}\\s+from|${namespace}:\\s*${namespace})`,
      ),
      `${locale} index must not expose retired ${namespace} translations`,
    )
  }

  for (const namespace of activeNamespaces) {
    assert.equal(
      existsSync(resolve(localeDir, `${namespace}.json`)),
      true,
      `${locale}/${namespace}.json must remain available`,
    )
    assert.match(
      indexSource,
      new RegExp(`import\\s+${namespace}\\s+from`),
      `${locale} index must keep active ${namespace} translations`,
    )
  }
}

console.log('retired locale namespace validation passed')
