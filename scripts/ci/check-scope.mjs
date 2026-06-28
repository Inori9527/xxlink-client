#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PRETTIER_EXTENSIONS = new Set([
  '.css',
  '.cjs',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.scss',
  '.ts',
  '.toml',
  '.tsx',
  '.yaml',
  '.yml',
])

const RUST_IMPACT_EXTENSIONS = new Set(['.rs'])
const RUST_IMPACT_FILES = new Set([
  '.cargo/config.toml',
  'Cargo.lock',
  'Cargo.toml',
  'rust-toolchain.toml',
  'rustfmt.toml',
])

function normalizeRepoPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '')
}

function parseArgs(argv) {
  const result = { mode: argv[2], options: {} }
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`)
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      result.options[key] = 'true'
    } else {
      result.options[key] = next
      i += 1
    }
  }
  return result
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    shell: false,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  })

  if (result.error) {
    throw result.error
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function runChecked(command, args, options = {}) {
  const result = run(command, args, options)
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${result.status}\n${result.stderr}${result.stdout}`,
    )
  }
  return result.stdout
}

function git(args, options = {}) {
  return runChecked('git', args, options).trim()
}

function resolveRepoRoot() {
  return git(['rev-parse', '--show-toplevel'])
}

function resolveRange(options = {}) {
  const base = options.base ?? process.env.CI_BASE_SHA
  const head = options.head ?? process.env.CI_HEAD_SHA

  if (!base || !head) {
    throw new Error(
      'CI_BASE_SHA and CI_HEAD_SHA are required; refusing to pass without a reliable range.',
    )
  }

  git(['rev-parse', '--verify', `${base}^{commit}`])
  git(['rev-parse', '--verify', `${head}^{commit}`])
  runChecked('git', [
    'diff',
    '--name-status',
    '--find-renames',
    `${base}...${head}`,
    '--',
  ])
  return { base, head }
}

function parseNameStatus(output) {
  if (!output.trim()) {
    return []
  }

  return output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t')
      const rawStatus = parts[0]
      const status = rawStatus[0]
      if ((status === 'R' || status === 'C') && parts.length >= 3) {
        return {
          status,
          rawStatus,
          oldPath: normalizeRepoPath(parts[1]),
          path: normalizeRepoPath(parts[2]),
        }
      }
      return {
        status,
        rawStatus,
        oldPath: null,
        path: normalizeRepoPath(parts[1] ?? ''),
      }
    })
}

function getChangedEntries(base, head) {
  return parseNameStatus(
    git(['diff', '--name-status', '--find-renames', `${base}...${head}`, '--']),
  )
}

function isExistingFile(repoRoot, repoPath) {
  if (!repoPath) {
    return false
  }
  const absolute = path.join(repoRoot, repoPath)
  return fs.existsSync(absolute) && fs.statSync(absolute).isFile()
}

function selectableChangedFiles(entries, repoRoot, predicate) {
  const skipped = []
  const selected = []

  for (const entry of entries) {
    if (entry.status === 'D') {
      skipped.push({ ...entry, reason: 'deleted' })
      continue
    }
    if (!isExistingFile(repoRoot, entry.path)) {
      skipped.push({ ...entry, reason: 'missing' })
      continue
    }
    if (!predicate(entry.path)) {
      skipped.push({ ...entry, reason: 'unsupported' })
      continue
    }
    selected.push(entry.path)
  }

  return { selected: [...new Set(selected)].sort(), skipped }
}

function isPrettierSupported(repoPath) {
  return PRETTIER_EXTENSIONS.has(path.extname(repoPath).toLowerCase())
}

function isRustSource(repoPath) {
  return path.extname(repoPath).toLowerCase() === '.rs'
}

function isRustImpacting(repoPath) {
  const normalized = normalizeRepoPath(repoPath)
  return (
    RUST_IMPACT_EXTENSIONS.has(path.extname(normalized).toLowerCase()) ||
    RUST_IMPACT_FILES.has(normalized) ||
    normalized.startsWith('src-tauri/') ||
    normalized.startsWith('crates/')
  )
}

function printSelection(label, selection) {
  console.log(`${label}: selected ${selection.selected.length} file(s).`)
  for (const filePath of selection.selected) {
    console.log(`  check ${filePath}`)
  }
  for (const item of selection.skipped) {
    console.log(`  skip ${item.path || item.oldPath} (${item.reason})`)
  }
}

function runPrettier({ base, head } = {}) {
  const repoRoot = resolveRepoRoot()
  const range = resolveRange({ base, head })
  const selection = selectableChangedFiles(
    getChangedEntries(range.base, range.head),
    repoRoot,
    isPrettierSupported,
  )
  printSelection('Prettier scoped check', selection)

  if (selection.selected.length === 0) {
    return 0
  }

  const prettierBin = path.join(
    repoRoot,
    'node_modules',
    'prettier',
    'bin',
    'prettier.cjs',
  )
  if (!fs.existsSync(prettierBin)) {
    throw new Error(
      'Prettier binary not found at node_modules/prettier/bin/prettier.cjs; run pnpm install first.',
    )
  }
  const result = run(
    process.execPath,
    [prettierBin, '--check', '--ignore-unknown', '--', ...selection.selected],
    {
      cwd: repoRoot,
    },
  )
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  return result.status
}

function runRustfmt({ base, head } = {}) {
  const repoRoot = resolveRepoRoot()
  const range = resolveRange({ base, head })
  const selection = selectableChangedFiles(
    getChangedEntries(range.base, range.head),
    repoRoot,
    isRustSource,
  )
  printSelection('Rustfmt scoped check', selection)

  if (selection.selected.length === 0) {
    return 0
  }

  const result = run(
    'rustfmt',
    [
      '--check',
      '--edition',
      '2024',
      '--config-path',
      'rustfmt.toml',
      ...selection.selected,
    ],
    {
      cwd: repoRoot,
    },
  )
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  return result.status
}

function rustImpact({ base, head } = {}) {
  const repoRoot = resolveRepoRoot()
  const range = resolveRange({ base, head })
  const entries = getChangedEntries(range.base, range.head).filter(
    (entry) => entry.status !== 'D',
  )
  const hasImpact = entries.some(
    (entry) =>
      isExistingFile(repoRoot, entry.path) && isRustImpacting(entry.path),
  )
  console.log(`Rust impact: ${hasImpact ? 'yes' : 'no'}`)
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `has_rust_impact=${hasImpact ? 'true' : 'false'}\n`,
    )
  }
  return 0
}

function normalizeDiagnosticPath(fileName, worktreeRoot) {
  if (!fileName) {
    return '<unknown>'
  }
  const normalized = normalizeRepoPath(fileName)
  if (path.isAbsolute(fileName)) {
    return normalizeRepoPath(path.relative(worktreeRoot, fileName))
  }
  if (normalized.startsWith('src-tauri/') || normalized.startsWith('crates/')) {
    return normalized
  }
  return normalizeRepoPath(path.join('src-tauri', normalized))
}

function normalizeMessage(message) {
  return String(message ?? '')
    .replace(/\\/g, '/')
    .replace(/:\d+:\d+/g, ':<line>:<col>')
    .replace(/line \d+/gi, 'line <n>')
    .replace(/\s+/g, ' ')
    .trim()
}

function diagnosticKey(diagnostic, targetTriple) {
  return [
    targetTriple || 'unknown-target',
    diagnostic.file,
    diagnostic.code || 'unknown-code',
    normalizeMessage(diagnostic.message),
  ].join('\u0000')
}

function parseCargoJsonDiagnostics(output, { worktreeRoot, targetTriple }) {
  const diagnostics = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) {
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed.reason !== 'compiler-message' || !parsed.message) {
      continue
    }
    const message = parsed.message
    if (!['error', 'warning'].includes(message.level)) {
      continue
    }
    const primarySpan =
      (message.spans ?? []).find((span) => span.is_primary) ??
      (message.spans ?? [])[0] ??
      {}
    const diagnostic = {
      code: message.code?.code ?? message.code?.rendered ?? null,
      file: normalizeDiagnosticPath(primarySpan.file_name, worktreeRoot),
      line: primarySpan.line_start ?? null,
      column: primarySpan.column_start ?? null,
      level: message.level,
      message: normalizeMessage(message.message),
      targetTriple,
    }
    diagnostics.push({
      ...diagnostic,
      key: diagnosticKey(diagnostic, targetTriple),
    })
  }
  return diagnostics
}

function compareDiagnostics(baseDiagnostics, headDiagnostics) {
  const baseKeys = new Set(baseDiagnostics.map((diagnostic) => diagnostic.key))
  return headDiagnostics.filter((diagnostic) => !baseKeys.has(diagnostic.key))
}

function runClippyInWorktree(worktreeRoot, targetTriple) {
  const result = run(
    'cargo',
    [
      'clippy',
      '--all-targets',
      '--all-features',
      '--message-format=json',
      '--',
      '-D',
      'warnings',
    ],
    {
      cwd: path.join(worktreeRoot, 'src-tauri'),
      maxBuffer: 256 * 1024 * 1024,
    },
  )
  const combined = `${result.stdout}\n${result.stderr}`
  const diagnostics = parseCargoJsonDiagnostics(combined, {
    worktreeRoot,
    targetTriple,
  })
  if (result.status !== 0 && diagnostics.length === 0) {
    throw new Error(
      `cargo clippy failed without parseable diagnostics:\n${combined}`,
    )
  }
  return { status: result.status, diagnostics, output: combined }
}

function addDetachedWorktree(repoRoot, ref, destination) {
  runChecked('git', ['worktree', 'add', '--detach', destination, ref], {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  })
}

function removeWorktree(repoRoot, destination) {
  run('git', ['worktree', 'remove', '--force', destination], {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  })
}

function runClippyBaseline({ base, head, targetTriple } = {}) {
  const repoRoot = resolveRepoRoot()
  const range = resolveRange({ base, head })
  const entries = getChangedEntries(range.base, range.head)
  const hasRustImpact = entries.some(
    (entry) => entry.status !== 'D' && isRustImpacting(entry.path),
  )
  if (!hasRustImpact) {
    console.log(
      'No Rust-impacting changes; skipping clippy baseline comparison.',
    )
    return 0
  }

  const triple =
    targetTriple ??
    process.env.CI_TARGET_TRIPLE ??
    process.env.RUNNER_OS ??
    'unknown-target'
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'xxlink-clippy-baseline-'),
  )
  const baseDir = path.join(tempRoot, 'base')
  const headDir = path.join(tempRoot, 'head')
  try {
    console.log(`Collecting clippy baseline for ${range.base} (${triple})`)
    addDetachedWorktree(repoRoot, range.base, baseDir)
    const baseResult = runClippyInWorktree(baseDir, triple)
    console.log(`Baseline diagnostics: ${baseResult.diagnostics.length}`)

    console.log(`Collecting clippy diagnostics for ${range.head} (${triple})`)
    addDetachedWorktree(repoRoot, range.head, headDir)
    const headResult = runClippyInWorktree(headDir, triple)
    console.log(`Head diagnostics: ${headResult.diagnostics.length}`)

    const newDiagnostics = compareDiagnostics(
      baseResult.diagnostics,
      headResult.diagnostics,
    )
    if (newDiagnostics.length === 0) {
      console.log('No new clippy diagnostics beyond baseline.')
      return 0
    }

    console.error(
      `New clippy diagnostics beyond baseline: ${newDiagnostics.length}`,
    )
    for (const diagnostic of newDiagnostics) {
      console.error(
        `  ${diagnostic.file}:${diagnostic.line ?? '?'}:${diagnostic.column ?? '?'} ` +
          `${diagnostic.code ?? 'unknown-code'} ${diagnostic.message}`,
      )
    }
    return 1
  } finally {
    removeWorktree(repoRoot, baseDir)
    removeWorktree(repoRoot, headDir)
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function main() {
  const { mode, options } = parseArgs(process.argv)
  if (!mode) {
    throw new Error(
      'Usage: node scripts/ci/check-scope.mjs <prettier|rustfmt|rust-impact|clippy> [--base SHA] [--head SHA]',
    )
  }

  if (mode === 'prettier') {
    return runPrettier(options)
  }
  if (mode === 'rustfmt') {
    return runRustfmt(options)
  }
  if (mode === 'rust-impact') {
    return rustImpact(options)
  }
  if (mode === 'clippy') {
    return runClippyBaseline({
      base: options.base,
      head: options.head,
      targetTriple: options['target-triple'],
    })
  }
  throw new Error(`Unknown mode: ${mode}`)
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
    .then((status) => {
      process.exitCode = status
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}

export {
  compareDiagnostics,
  diagnosticKey,
  isPrettierSupported,
  isRustImpacting,
  normalizeMessage,
  normalizeRepoPath,
  parseCargoJsonDiagnostics,
  parseNameStatus,
  selectableChangedFiles,
}
