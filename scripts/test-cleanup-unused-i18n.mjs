#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')
const cleanupScript = path.join(repoRoot, 'scripts/cleanup-unused-i18n.mjs')
const temporaryDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'xxlink-i18n-scanner-'),
)
const reportPath = path.join(temporaryDir, 'report.json')

try {
  execFileSync(process.execPath, [cleanupScript, '--report', reportPath], {
    cwd: repoRoot,
    stdio: 'pipe',
  })

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const frontendEn = report.results.find(
    (result) => result.group === 'frontend' && result.locale === 'en',
  )

  assert.ok(frontendEn, 'the frontend English locale report should exist')
  assert.ok(
    frontendEn.unusedKeys.includes('connections.page.title'),
    'generated i18n types must not keep retired keys marked as used',
  )
  assert.ok(
    !frontendEn.unusedKeys.includes('plans.page.title'),
    'real frontend consumers must continue to keep active keys marked as used',
  )

  console.log('i18n cleanup generated-type exclusion checks passed')
} finally {
  fs.rmSync(temporaryDir, { recursive: true, force: true })
}
