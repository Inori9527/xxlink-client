import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  compareDiagnostics,
  diagnosticKey,
  isPrettierSupported,
  isRustImpacting,
  parseCargoJsonDiagnostics,
  parseNameStatus,
  selectableChangedFiles,
} from './check-scope.mjs'

// PROVES:         Executes the code under test. Imports check-scope.mjs's own helpers
//                 and runs them over constructed inputs -- diff name-status lines,
//                 cargo JSON diagnostics, path sets -- asserting which changes it
//                 classifies as Rust-impacting or Prettier-supported.
// DOES NOT PROVE: that any workflow calls check-scope.mjs with these inputs, or that
//                 a real diff produces the shapes constructed here. This file sits
//                 under scripts/ci/ rather than scripts/, which is why the M27
//                 labelling round -- which enumerated the root corpus, 27 files --
//                 did not reach it. Counted recursively the corpus is 28.

test('name-status parser handles modified, copied, renamed, and deleted files', () => {
  const entries = parseNameStatus(
    [
      'M\tsrc/main.tsx',
      'A\tscripts/ci/check-scope.mjs',
      'C100\tsrc/old.ts\tsrc/copied.ts',
      'R091\tsrc/old-name.ts\tsrc/new-name.ts',
      'D\tsrc/deleted.ts',
    ].join('\n'),
  )

  assert.deepEqual(entries, [
    { status: 'M', rawStatus: 'M', oldPath: null, path: 'src/main.tsx' },
    {
      status: 'A',
      rawStatus: 'A',
      oldPath: null,
      path: 'scripts/ci/check-scope.mjs',
    },
    {
      status: 'C',
      rawStatus: 'C100',
      oldPath: 'src/old.ts',
      path: 'src/copied.ts',
    },
    {
      status: 'R',
      rawStatus: 'R091',
      oldPath: 'src/old-name.ts',
      path: 'src/new-name.ts',
    },
    { status: 'D', rawStatus: 'D', oldPath: null, path: 'src/deleted.ts' },
  ])
})

test('prettier selection checks existing supported files and skips deleted or unsupported files', () => {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'xxlink-prettier-selection-'),
  )
  try {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    fs.writeFileSync(path.join(repoRoot, 'src', 'main.tsx'), 'export {};\n')
    fs.writeFileSync(path.join(repoRoot, 'src', 'notes.txt'), 'plain text\n')
    const entries = parseNameStatus(
      ['M\tsrc/main.tsx', 'M\tsrc/notes.txt', 'D\tsrc/deleted.ts'].join('\n'),
    )

    const selection = selectableChangedFiles(
      entries,
      repoRoot,
      isPrettierSupported,
    )
    assert.deepEqual(selection.selected, ['src/main.tsx'])
    assert.equal(
      selection.skipped.find((item) => item.path === 'src/notes.txt').reason,
      'unsupported',
    )
    assert.equal(
      selection.skipped.find((item) => item.path === 'src/deleted.ts').reason,
      'deleted',
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('rustfmt selection checks only existing changed Rust files', () => {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'xxlink-rustfmt-selection-'),
  )
  try {
    fs.mkdirSync(path.join(repoRoot, 'src-tauri', 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(repoRoot, 'src-tauri', 'src', 'lib.rs'),
      'fn main() {}\n',
    )
    fs.writeFileSync(
      path.join(repoRoot, 'src-tauri', 'Cargo.toml'),
      '[package]\n',
    )
    const entries = parseNameStatus(
      [
        'M\tsrc-tauri/src/lib.rs',
        'M\tsrc-tauri/Cargo.toml',
        'D\tsrc-tauri/src/old.rs',
      ].join('\n'),
    )

    const selection = selectableChangedFiles(entries, repoRoot, (filePath) =>
      filePath.endsWith('.rs'),
    )
    assert.deepEqual(selection.selected, ['src-tauri/src/lib.rs'])
    assert.equal(
      selection.skipped.find((item) => item.path === 'src-tauri/Cargo.toml')
        .reason,
      'unsupported',
    )
    assert.equal(
      selection.skipped.find((item) => item.path === 'src-tauri/src/old.rs')
        .reason,
      'deleted',
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('rust impact detects source, crate, cargo, and toolchain changes', () => {
  assert.equal(isRustImpacting('src-tauri/src/lib.rs'), true)
  assert.equal(isRustImpacting('crates/xxlink-i18n/src/lib.rs'), true)
  assert.equal(isRustImpacting('Cargo.lock'), true)
  assert.equal(isRustImpacting('.cargo/config.toml'), true)
  assert.equal(isRustImpacting('src/pages/connect.tsx'), false)
})

test('clippy diagnostic keys ignore line drift and include target triple', () => {
  const first = {
    code: 'unused_imports',
    file: 'src-tauri/src/utils/arch_check.rs',
    line: 13,
    column: 5,
    message: 'unused import: `std::path::Path`',
  }
  const second = {
    ...first,
    line: 99,
    column: 1,
  }

  assert.equal(
    diagnosticKey(first, 'x86_64-unknown-linux-gnu'),
    diagnosticKey(second, 'x86_64-unknown-linux-gnu'),
  )
  assert.notEqual(
    diagnosticKey(first, 'x86_64-unknown-linux-gnu'),
    diagnosticKey(first, 'aarch64-apple-darwin'),
  )
})

test('clippy parser and comparator allow baseline diagnostics but fail new diagnostics', () => {
  const warning = {
    reason: 'compiler-message',
    message: {
      level: 'error',
      message: 'unused import: `std::path::Path`',
      code: { code: 'unused_imports' },
      spans: [
        {
          is_primary: true,
          file_name: 'src/utils/arch_check.rs',
          line_start: 13,
          column_start: 5,
        },
      ],
    },
  }
  const shiftedWarning = {
    reason: 'compiler-message',
    message: {
      ...warning.message,
      spans: [
        {
          is_primary: true,
          file_name: 'src/utils/arch_check.rs',
          line_start: 88,
          column_start: 2,
        },
      ],
    },
  }
  const newWarning = {
    reason: 'compiler-message',
    message: {
      level: 'error',
      message: 'function `new_issue` is never used',
      code: { code: 'dead_code' },
      spans: [
        {
          is_primary: true,
          file_name: 'src/new_issue.rs',
          line_start: 7,
          column_start: 1,
        },
      ],
    },
  }

  const baseDiagnostics = parseCargoJsonDiagnostics(JSON.stringify(warning), {
    worktreeRoot: '/tmp/base',
    targetTriple: 'x86_64-unknown-linux-gnu',
  })
  const headDiagnostics = parseCargoJsonDiagnostics(
    `${JSON.stringify(shiftedWarning)}\n${JSON.stringify(newWarning)}`,
    {
      worktreeRoot: '/tmp/head',
      targetTriple: 'x86_64-unknown-linux-gnu',
    },
  )

  const diff = compareDiagnostics(baseDiagnostics, headDiagnostics)
  assert.equal(diff.length, 1)
  assert.equal(diff[0].code, 'dead_code')
  assert.equal(diff[0].file, 'src-tauri/src/new_issue.rs')
})

test('CLI fails closed when base/head are missing', () => {
  const env = { ...process.env }
  delete env.CI_BASE_SHA
  delete env.CI_HEAD_SHA
  const result = spawnSync(
    process.execPath,
    ['scripts/ci/check-scope.mjs', 'prettier'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env,
    },
  )

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /CI_BASE_SHA and CI_HEAD_SHA are required/)
})
