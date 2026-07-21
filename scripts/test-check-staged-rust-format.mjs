import assert from 'node:assert/strict'
import test from 'node:test'

import { main } from './check-staged-rust-format.mjs'

function runnerFor(stagedOutput, { unstagedPaths = [] } = {}) {
  const calls = []
  const runCommand = (command, args) => {
    calls.push({ command, args })

    if (command === 'git' && args[0] === 'diff' && args[1] === '--cached') {
      return { status: 0, stdout: stagedOutput, stderr: '' }
    }

    if (command === 'git' && args[0] === 'diff' && args[1] === '--quiet') {
      const path = args.at(-1)
      return {
        status: unstagedPaths.includes(path) ? 1 : 0,
        stdout: '',
        stderr: '',
      }
    }

    return { status: 0, stdout: '', stderr: '' }
  }

  return { calls, runCommand }
}

test('does not invoke rustfmt when no staged Rust files exist', () => {
  const { calls, runCommand } = runnerFor('README.md\0src/main.ts\0')

  main({ runCommand })

  assert.equal(
    calls.some(({ command }) => command === 'rustfmt'),
    false,
  )
})

test('filters non-Rust paths from the staged file list', () => {
  const { calls, runCommand } = runnerFor(
    'src/main.rs\0README.md\0src/lib.ts\0',
  )

  main({ runCommand })

  assert.deepEqual(calls.at(-1), {
    command: 'rustfmt',
    args: [
      '--edition',
      '2024',
      '--config',
      'skip_children=true',
      '--check',
      'src/main.rs',
    ],
  })
})

test('rejects staged Rust files with unstaged worktree differences', () => {
  const { calls, runCommand } = runnerFor('src/main.rs\0', {
    unstagedPaths: ['src/main.rs'],
  })

  assert.throws(() => main({ runCommand }), /unstaged worktree differences/)
  assert.equal(
    calls.some(({ command }) => command === 'rustfmt'),
    false,
  )
})

test('runs rustfmt with the exact staged Rust paths', () => {
  const { calls, runCommand } = runnerFor(
    'src/main.rs\0crates/core/src/lib.rs\0docs/example.md\0',
  )

  main({ runCommand })

  assert.deepEqual(calls.at(-1), {
    command: 'rustfmt',
    args: [
      '--edition',
      '2024',
      '--config',
      'skip_children=true',
      '--check',
      'src/main.rs',
      'crates/core/src/lib.rs',
    ],
  })
})
