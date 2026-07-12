#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { updateLocaleData } from './cleanup-unused-i18n.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')
const temporarySource = path.join(root, 'src', '__i18n-cleanup-usage-test.ts')
const temporaryGeneratedSource = path.join(
  root,
  'src',
  'types',
  'generated',
  '__i18n-cleanup-generated-test.ts',
)
const temporaryReport = path.join(root, 'tmp-i18n-cleanup-test-report.json')
const retiredKey = 'connections.page.title'

function assertSafeI18nScripts() {
  const scripts = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ).scripts

  assert.match(scripts['i18n:format'], /--align\s+--preserve-unused/)
  assert.doesNotMatch(scripts['i18n:format'], /--apply/)
  assert.match(scripts['i18n:align'], /--align\s+--apply\s+--preserve-unused/)
  assert.match(scripts['i18n:prune'], /--align\s+--apply/)
  assert.doesNotMatch(scripts['i18n:prune'], /--preserve-unused/)
}

function writeTemporarySources(realUsage) {
  fs.writeFileSync(
    temporaryGeneratedSource,
    `export type GeneratedOnlyKey = '${retiredKey}'\n`,
    'utf8',
  )
  fs.writeFileSync(
    temporarySource,
    realUsage
      ? `const key = '${retiredKey}'\nvoid key\n`
      : "const key = 'plans.page.title'\nvoid key\n",
    'utf8',
  )
}

function readUnusedFrontendKeys() {
  fs.rmSync(temporaryReport, { force: true })
  execFileSync(
    'node',
    ['scripts/cleanup-unused-i18n.mjs', '--report', temporaryReport],
    {
      cwd: root,
      stdio: 'pipe',
    },
  )
  const report = JSON.parse(fs.readFileSync(temporaryReport, 'utf8'))
  const frontend = report.results.find(
    (result) => result.group === 'frontend' && result.locale === 'en',
  )
  assert.ok(frontend, 'frontend baseline report should exist')
  return frontend.unusedKeys
}

try {
  assertSafeI18nScripts()

  writeTemporarySources(false)
  assert.ok(
    readUnusedFrontendKeys().includes(retiredKey),
    'generated i18n types must not count as a runtime translation consumer',
  )

  writeTemporarySources(true)
  assert.ok(
    !readUnusedFrontendKeys().includes(retiredKey),
    'a real source consumer must keep its translation key in use',
  )

  const baseline = { retired: { label: 'Retained translation' } }
  const preserved = updateLocaleData(baseline, baseline, ['retired.label'], {
    align: true,
    preserveUnused: true,
  })
  assert.deepEqual(preserved.updated, baseline)
  assert.deepEqual(preserved.removed, [])

  const localeWithExtraUnusedKey = {
    active: { label: 'Active translation' },
    retired: { label: 'Retained translation' },
  }
  const preservedExtra = updateLocaleData(
    { active: { label: 'Active translation' } },
    localeWithExtraUnusedKey,
    ['retired.label'],
    { align: true, preserveUnused: true },
  )
  assert.deepEqual(preservedExtra.updated, localeWithExtraUnusedKey)
  assert.deepEqual(preservedExtra.removed, [])

  const pruned = updateLocaleData(baseline, baseline, ['retired.label'], {
    align: true,
    preserveUnused: false,
  })
  assert.deepEqual(pruned.updated, {})
  assert.deepEqual(pruned.removed, ['retired.label'])

  console.log('i18n cleanup safety checks passed')
} finally {
  fs.rmSync(temporarySource, { force: true })
  fs.rmSync(temporaryGeneratedSource, { force: true })
  fs.rmSync(temporaryReport, { force: true })
}
