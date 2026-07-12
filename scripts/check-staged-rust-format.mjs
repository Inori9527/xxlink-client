import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })

  if (result.error) {
    throw result.error
  }

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

export function parseStagedPaths(output) {
  return output.split('\0').filter(Boolean)
}

export function stagedRustPaths(output) {
  return parseStagedPaths(output).filter((path) => path.endsWith('.rs'))
}

function assertCommandSucceeded(result, command, args) {
  if (result.status !== 0) {
    const details = result.stderr.trim()
    throw new Error(
      `${command} ${args.join(' ')} failed${details ? `: ${details}` : ''}`,
    )
  }
}

export function main({ runCommand = defaultRunCommand } = {}) {
  const stagedResult = runCommand('git', [
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=ACMR',
    '-z',
  ])
  assertCommandSucceeded(stagedResult, 'git', [
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=ACMR',
    '-z',
  ])

  const rustPaths = stagedRustPaths(stagedResult.stdout)

  for (const path of rustPaths) {
    const args = ['diff', '--quiet', '--', path]
    const result = runCommand('git', args)
    if (result.status === 1) {
      throw new Error(
        `staged Rust file has unstaged worktree differences: ${path}`,
      )
    }
    assertCommandSucceeded(result, 'git', args)
  }

  if (rustPaths.length > 0) {
    const args = [
      '--edition',
      '2024',
      '--config',
      'skip_children=true',
      '--check',
      ...rustPaths,
    ]
    const result = runCommand('rustfmt', args)
    assertCommandSucceeded(result, 'rustfmt', args)
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
}
