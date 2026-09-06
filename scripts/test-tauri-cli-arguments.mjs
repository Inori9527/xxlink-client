import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  // PROVES:         Executes the code under test. Two layers, both of which actually run
  //                 the code under test;
  // DOES NOT PROVE: Nothing is ever packaged: no build, bundle, signing or notarization
  //                 step runs, so none of this shows the guard holds during a real
  //                 `tauri build`. Most probes end in --help or --version; two do not --
  //                 an unknown-command probe and a `build -- --target-dir` probe -- and
  //                 an earlier version of this line claimed every one of them did.
  getTauriCommandIndex,
  getTauriPackagingInputs,
  getTauriPackagingPlan,
  resolveTauriPlatform,
} from './tauri-build-arguments.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wrapperPath = path.join(root, 'scripts', 'tauri-cli.mjs')
const cleanEnvironment = { ...process.env }
for (const variable of [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_TEAM_ID',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
  'TAURI_CONFIG',
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
]) {
  delete cleanEnvironment[variable]
}

const runWrapper = (args, environment = cleanEnvironment) =>
  spawnSync(process.execPath, [wrapperPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: environment,
  })

const wrapperOutput = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`

test('locates build after supported global options', () => {
  assert.equal(getTauriCommandIndex(['build']), 0)
  assert.equal(getTauriCommandIndex(['-v', 'build']), 1)
  assert.equal(getTauriCommandIndex(['--verbose', '-vv', 'build']), 2)
  assert.equal(getTauriCommandIndex(['plugin', 'build']), 0)
  assert.throws(
    () => getTauriCommandIndex(['--unknown', 'build']),
    /Unsupported Tauri global option/u,
  )
})

test('parses supported target argument forms for packaging commands', () => {
  assert.deepEqual(
    getTauriPackagingInputs(['build', '-t', 'x86_64-pc-windows-gnu']),
    {
      target: 'x86_64-pc-windows-gnu',
    },
  )
  assert.deepEqual(
    getTauriPackagingInputs(['build', '-tx86_64-unknown-linux-gnu']),
    {
      target: 'x86_64-unknown-linux-gnu',
    },
  )
})

test('accepts only the reviewed fast-release runner profile', () => {
  assert.deepEqual(
    getTauriPackagingInputs([
      'build',
      '--target=aarch64-apple-darwin',
      '--',
      '--profile',
      'fast-release',
    ]),
    {
      target: 'aarch64-apple-darwin',
    },
  )
  assert.throws(
    () =>
      getTauriPackagingInputs([
        'build',
        '--',
        '--target-dir',
        'unreviewed-output',
      ]),
    /Unsupported guarded build runner arguments/u,
  )
})

test('rejects dynamic packaging config channels and unsupported targets', () => {
  for (const args of [
    ['build', '--config', 'one.json'],
    ['build', '--config=one.json'],
    ['build', '-cone.json'],
    ['bundle', '-c', 'one.json'],
    ['bundle', '-vcunsafe.json'],
  ]) {
    assert.throws(
      () => getTauriPackagingInputs(args),
      /does not accept dynamic config overlays/u,
    )
  }
  assert.throws(
    () => getTauriPackagingInputs(['build', '--target=']),
    /requires a target value/u,
  )
  assert.throws(
    () => resolveTauriPlatform('unsupported-target', 'win32'),
    /Unsupported Tauri desktop target/u,
  )
  assert.throws(
    () => getTauriPackagingInputs(['build', '-dtx86_64-pc-windows-gnu']),
    /Combined target syntax is not supported/u,
  )
  assert.throws(
    () =>
      getTauriPackagingPlan(['build'], 'win32', {
        TAURI_CONFIG: '{"app":{"security":{"csp":null}}}',
      }),
    /TAURI_CONFIG is not allowed/u,
  )
})

test('resolves target platforms before falling back to the host', () => {
  assert.equal(
    resolveTauriPlatform('x86_64-pc-windows-gnu', 'linux'),
    'windows',
  )
  assert.equal(resolveTauriPlatform('aarch64-apple-darwin', 'win32'), 'macos')
  assert.equal(resolveTauriPlatform(undefined, 'linux'), 'linux')
})

test('plans guarded build validation and rejects standalone bundle', () => {
  assert.deepEqual(
    getTauriPackagingPlan(
      ['--verbose', 'build', '--target', 'x86_64-pc-windows-gnu'],
      'linux',
    ),
    {
      command: 'build',
      commandIndex: 1,
      platform: 'windows',
      target: 'x86_64-pc-windows-gnu',
    },
  )
  assert.throws(
    () => getTauriPackagingPlan(['bundle'], 'darwin'),
    /Standalone Tauri bundle is disabled/u,
  )
  assert.equal(getTauriPackagingPlan(['signer', '--help'], 'win32'), undefined)
})

test('wrapper validates build before Tauri executes and rejects standalone bundle', () => {
  const buildResult = runWrapper(['build', '--help'])
  const buildOutput = wrapperOutput(buildResult)
  const buildHelpSignature = /Build your app in release mode/u
  assert.equal(buildResult.status, 0, `build --help failed:\n${buildOutput}`)
  assert.match(buildOutput, /CSP policy validation passed/u)
  assert.match(buildOutput, buildHelpSignature)
  assert.ok(
    buildOutput.indexOf('CSP policy validation passed') <
      buildOutput.search(buildHelpSignature),
    'build must validate before dispatching to the Tauri CLI',
  )

  const bundleResult = runWrapper(['bundle', '--help'])
  const bundleOutput = wrapperOutput(bundleResult)
  assert.notEqual(bundleResult.status, 0)
  assert.match(bundleOutput, /Standalone Tauri bundle is disabled/u)
  assert.doesNotMatch(
    bundleOutput,
    /Generate bundles and installers for your app/u,
  )

  const versionResult = runWrapper(['--version'])
  const versionOutput = wrapperOutput(versionResult)
  assert.equal(versionResult.status, 0, `--version failed:\n${versionOutput}`)
  assert.match(versionOutput, /tauri-cli \d+\.\d+\.\d+/u)
  assert.doesNotMatch(versionOutput, /CSP policy validation passed/u)

  const invalidResult = runWrapper(['definitely-not-a-tauri-command'])
  assert.notEqual(
    invalidResult.status,
    0,
    'the wrapper must propagate a failing Tauri CLI status',
  )
  assert.match(wrapperOutput(invalidResult), /unrecognized subcommand/u)
})

test('wrapper rejects inherited TAURI_CONFIG without echoing its value', () => {
  const sentinel = 'DO_NOT_PRINT_TAURI_CONFIG_VALUE'
  const result = runWrapper(['build', '--help'], {
    ...cleanEnvironment,
    TAURI_CONFIG: sentinel,
  })
  const output = wrapperOutput(result)

  assert.notEqual(result.status, 0)
  assert.match(output, /TAURI_CONFIG is not allowed/u)
  assert.doesNotMatch(output, new RegExp(sentinel, 'u'))
})

test('wrapper rejects config-like arguments without echoing their values', () => {
  const sentinel = 'DO_NOT_PRINT_DYNAMIC_CONFIG_VALUE'
  const probes = [
    [`--config=${sentinel}`, 'build', '--help'],
    ['build', `--config=${sentinel}`, '--help'],
    ['build', '--config', sentinel, '--help'],
    ['build', `-c${sentinel}`, '--help'],
    ['build', '--target', `--config=${sentinel}`, '--help'],
    ['build', `--target=--config=${sentinel}`, '--help'],
    ['bundle', '-c', sentinel, '--help'],
  ]

  for (const args of probes) {
    const result = runWrapper(args)
    const output = wrapperOutput(result)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(output, new RegExp(sentinel, 'u'))
  }
})

test('wrapper rejects alternate runners and unreviewed runner arguments without echoing values', () => {
  const sentinel = 'DO_NOT_PRINT_ALTERNATE_RUNNER_VALUE'
  const probes = [
    ['build', '--runner', sentinel, '--help'],
    ['build', `--runner=${sentinel}`, '--help'],
    ['build', '-r', sentinel, '--help'],
    ['build', `-r${sentinel}`, '--help'],
    ['build', `-vr${sentinel}`, '--help'],
    ['build', '--', '--target-dir', sentinel],
  ]

  for (const args of probes) {
    const result = runWrapper(args)
    const output = wrapperOutput(result)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(output, new RegExp(sentinel, 'u'))
  }
})
