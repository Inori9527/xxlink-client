import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getTauriPackagingPlan } from './tauri-build-arguments.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

const run = (executable, commandArgs) => {
  const result = spawnSync(executable, commandArgs, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })

  if (result.error) throw result.error
  if (result.signal) {
    throw new Error(`Command terminated by signal ${result.signal}`)
  }
  return result.status ?? 1
}

const packagingPlan = getTauriPackagingPlan(args, process.platform, process.env)
if (packagingPlan) {
  const validationArgs = [
    path.join(root, 'scripts', 'validate-csp-policy.mjs'),
    '--platform',
    packagingPlan.platform,
  ]

  const validationStatus = run(process.execPath, validationArgs)
  if (validationStatus !== 0) process.exit(validationStatus)
}

const tauriEntrypoint = path.join(
  root,
  'node_modules',
  '@tauri-apps',
  'cli',
  'tauri.js',
)
process.exit(run(process.execPath, [tauriEntrypoint, ...args]))
