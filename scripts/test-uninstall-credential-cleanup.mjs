import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..')

const readSource = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), 'utf8')

// Everything below asserts against installer.nsi with its comments removed.
// Searching the raw text reads commented-out code as if it were live: a
// mutation run that prefixed the desktop-user credential delete with "; "
// left every assertion green, because the string was still in the file. That
// is the failure this whole change is about -- a check whose output is the
// same whether or not the thing it checks is there.
const executableSource = (nsi) =>
  nsi
    // NSIS honours /* */ as well. Blank the body but keep the line breaks so
    // the indentation-based branch delimiting further down still lines up. A
    // mutation that wrapped the credential cleanup in a block comment left
    // every assertion in this file green.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ''))
    .split('\n')
    .map((line) => {
      let quote = null
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i]
        // $\"  $\'  $\`  $\n: NSIS escapes, never delimiters.
        // Skipping the pair stops a quote inside a string from flipping the
        // scanner's state for the rest of the line.
        if (c === '$' && line[i + 1] === '\\') {
          i += 1
          continue
        }
        if (quote) {
          if (c === quote) quote = null
        } else if (c === "'" || c === '"' || c === '`') {
          quote = c
        } else if (c === ';' || c === '#') {
          return line.slice(0, i)
        }
      }
      return line
    })
    .join('\n')

// The session tokens are keyring entries in Windows Credential Manager, not
// files under $APPDATA. "Delete app data" removed the directories and left the
// credential, so a user who uninstalled kept a live token on the machine
// permanently -- and the same held for a logout interrupted before its delete
// step, which persists the secret under the logout-pending account. These
// assertions exist because the leak was invisible from the filesystem: an
// acceptance test that only inspects $APPDATA passes while the token remains.
test('uninstaller clears the credential vault when app data is deleted', () => {
  const nsi = executableSource(
    readSource('src-tauri/packages/windows/installer.nsi'),
  )

  // Both keyring accounts must be cleared. "primary" holds the tokens;
  // "logout-pending" holds a partially completed logout, which still contains
  // them, so clearing only the first leaves the interrupted-logout case open.
  // The vault's own constants are the source of truth. Read them out of the
  // Rust rather than restating them here, so this assertion cannot drift the
  // way the code it guards could.
  const rust = readSource('src-tauri/src/cmd/secure_session.rs')
  const service = /const VAULT_SERVICE: &str = "([^"]+)"/.exec(rust)?.[1]
  const primary = /const VAULT_ACCOUNT: &str = "([^"]+)"/.exec(rust)?.[1]
  const pending = /const VAULT_LOGOUT_MARKER_ACCOUNT: &str = "([^"]+)"/.exec(
    rust,
  )?.[1]
  assert.ok(
    service && primary && pending,
    'vault constants not found in secure_session.rs',
  )

  // Each account is cleared TWICE, because the two contexts reach different
  // stores. Credential Manager entries are DPAPI-encrypted per user and
  // `cmdkey /delete` acts on the caller's own store, so an uninstaller elevated
  // with a different administrator account clears that administrator's vault
  // and leaves the real user's untouched. RunAsUser runs the same command under
  // the interactive desktop user's token, which is the one DPAPI resolves
  // against. An earlier revision shipped only the elevated half and a comment
  // asserting the other half was impossible; it was not, and this installer was
  // already using RunAsUser two other places at the time.
  for (const account of [primary, pending]) {
    const target = `/delete:${account}.${service}`
    assert.ok(
      nsi.includes(`nsExec::Exec '"$SYSDIR\\cmdkey.exe" ${target}'`),
      `uninstaller does not clear "${account}.${service}" in the elevated context`,
    )
    assert.ok(
      nsi.includes(
        `nsis_tauri_utils::RunAsUser "$SYSDIR\\cmdkey.exe" "${target}"`,
      ),
      `uninstaller does not clear "${account}.${service}" as the desktop user`,
    )
  }

  // Both sides literal, and asserted equal. An earlier version of this file
  // required the NSIS side to use ${BUNDLEID}, on the theory that
  // parameterising it survived a bundle id change. That was backwards: the
  // producing side is the Rust literal above, so parameterising only the
  // consumer would move the installer and leave the vault behind -- the very
  // drift it claimed to prevent. Comparing the two literals catches drift in
  // either direction, which matters because cmdkey exits non-zero for a target
  // that is simply absent, so a wrong target and a clean run look identical.
  const bundleId = /"identifier": "([^"]+)"/.exec(
    readSource('src-tauri/tauri.conf.json'),
  )?.[1]
  assert.ok(bundleId, 'bundle identifier not found in tauri.conf.json')
  assert.equal(
    service,
    `${bundleId}.secure-session`,
    `VAULT_SERVICE (${service}) and the bundle id (${bundleId}) have drifted; ` +
      'the uninstaller targets one of them and the vault uses the other',
  )

  // The user's own directories are deleted as that user too, and for the same
  // reason as the vault: an uninstaller elevated with a different administrator
  // account otherwise deletes that administrator's copy. Doing it by sweeping
  // every profile from an elevated context was tried and withdrawn -- RmDir /r
  // follows reparse points, so a junction planted by a standard user redirects
  // an administrator's recursive delete out of the profile.
  assert.match(
    nsi,
    /nsis_tauri_utils::RunAsUser "\$SYSDIR\\cmd\.exe" '\/c rmdir \/s \/q "%APPDATA%\\\$\{BUNDLEID\}" & rmdir \/s \/q "%LOCALAPPDATA%\\\$\{BUNDLEID\}"'/,
    "uninstaller does not delete the desktop user's own app data as that user",
  )

  // The deletions have to sit inside the delete-app-data branch. Outside it, an
  // update or a plain uninstall would sign the user out as a side effect.
  //
  // Delimit by the branch's own indentation rather than by the first
  // terminator: the block has contained nested conditionals, and an earlier
  // version of this assertion stopped at the first one it saw and reported the
  // deletion as "outside the branch" while it sat inside a nested block. The
  // line-ending is detected because a checkout can materialise this file with
  // CRLF (core.autocrlf), and an LF-only needle silently never matches -- the
  // assertion would then fail for a reason unrelated to what it checks.
  const branchStart = nsi.indexOf('$DeleteAppDataCheckboxState = 1')
  assert.notEqual(branchStart, -1, 'delete-app-data branch not found')
  const eol = nsi.includes('\r\n') ? '\r\n' : '\n'
  const terminator = `${eol}  \${EndIf}`
  const branchEnd = nsi.indexOf(terminator, branchStart)
  assert.notEqual(branchEnd, -1, 'delete-app-data branch has no terminator')
  const branch = nsi.slice(branchStart, branchEnd)
  // Both targets, not just the first. Asserting only `primary` let the
  // logout-pending deletion drift outside the branch unnoticed -- and that is
  // the one carrying an interrupted logout's secret, so it is the half that
  // must not be skipped on an update or a plain uninstall either.
  for (const account of [primary, pending]) {
    assert.equal(
      (branch.match(new RegExp(`/delete:${account}\\.`, 'g')) ?? []).length,
      2,
      `"${account}" is not cleared in both contexts inside the delete-app-data branch`,
    )
  }
})

// Both the installer and the uninstaller run elevated, from whatever directory
// the user launched them in. A bare program name is resolved by the executable
// search order, which reaches that directory -- so an attacker who can write
// there gets their own cmdkey.exe or netsh.exe executed with the elevated
// token. The uninstaller shipped `cmdkey /delete:...` bare for two review
// rounds without anyone reading it as a program lookup.
// The two reinstall launches pass the OTHER product's UninstallString, which
// already carries its own quoting plus arguments -- ours is written quoted at
// installer.nsi:1049. Wrapping the whole value makes CreateProcess read the
// program path as the entire string, so the reinstall/upgrade path fails
// outright. A previous revision shipped exactly that, while closing a
// search-order hole that did not exist on this branch.
test('the reinstall launches pass UninstallString unwrapped', () => {
  const executable = executableSource(
    readSource('src-tauri/packages/windows/installer.nsi'),
  )
  const wrapped = [...executable.matchAll(/ExecWait[^\S\r\n]+(\S+)/g)]
    .map((m) => m[1])
    // The captured operand still carries NSIS's own delimiters, so strip them
    // before comparing. Compared without stripping first, this assertion never
    // fired: the mutation that re-introduced the regression walked straight
    // through the line written to catch it, and only a mutation run said so.
    .map((op) => op.replace(/^['"`]/, '').replace(/['"`]$/, ''))
    .filter((op) => op === '"$R1"')
  assert.deepEqual(
    wrapped,
    [],
    'ExecWait must pass $R1 unwrapped: the value already contains a quoted ' +
      'program path followed by arguments, so another pair of quotes makes ' +
      'the whole command line the program name',
  )
})

test('every external program is invoked by an absolute path', () => {
  const executable = executableSource(
    readSource('src-tauri/packages/windows/installer.nsi'),
  )

  // The program is the first argument of the call. It may be bare ($R1), or
  // quoted inside the command string ('"$SYSDIR\\netsh.exe" int tcp res'), and
  // NSIS accepts ' " and ` as string delimiters.
  // Longest first: `Exec` is a prefix of the other three, and leaving it out
  // entirely was a real bypass -- `Exec 'cmdkey /list'` and
  // `ExecShellWait "open" "cmdkey"` both launched a bare program past this
  // scan while it reported the file clean.
  // ExecShell's syntax is `ExecShell "verb" "command" [params] [SW_*]`, so its
  // program is the SECOND operand. Reading operand 1 as the program both let
  // `ExecShell "$R2" "netsh.exe"` through and reported the legitimate
  // `ExecShell "open" "$INSTDIR\\app.exe"` as an offender.
  const CALL =
    /(?:nsExec::Exec(?:ToLog|ToStack)?|nsis_tauri_utils::RunAsUser|\bExecShellWait|\bExecShell|\bExecWait|\bExec)[^\S\r\n]+(.*)/g
  const operands = (rest) => {
    const out = []
    let cur = ''
    let quote = null
    for (const c of rest) {
      if (quote) {
        if (c === quote) {
          quote = null
          out.push(cur)
          cur = ''
        } else cur += c
      } else if (c === "'" || c === '"' || c === '`') {
        quote = c
      } else if (/\s/.test(c)) {
        if (cur) {
          out.push(cur)
          cur = ''
        }
      } else cur += c
    }
    if (cur) out.push(cur)
    return out
  }
  const offenders = []
  for (const [whole, rest] of executable.matchAll(CALL)) {
    const isShell = /^\s*ExecShell/.test(whole)
    const ops = operands(rest)
    // A quoted command string carries the program as its own first token.
    const first = (ops[isShell ? 1 : 0] || '').trim().split(/\s+/)[0]
    const program = first.replace(/^[`'"]+/, '').replace(/[`'"]+$/, '')
    // Every legitimate call names an NSIS variable or constant: $SYSDIR,
    // $INSTDIR, $TEMP, or a register holding a path read from the registry.
    if (program && !program.startsWith('$')) offenders.push(whole.trim())
  }

  assert.deepEqual(
    offenders,
    [],
    `these invocations resolve the program through the executable search order:\n  ${offenders.join('\n  ')}`,
  )
})

// The vault side of the same defect: logout persists the secret under the
// logout-pending account before deleting it, so an interruption between those
// two steps leaves a real token behind. Recovery only runs at the next app
// start, which never happens if the user's next act is to uninstall. That makes
// the uninstaller the last line of defence, which is why the assertions above
// have to keep holding.
test('logout still deletes the credential rather than only marking it', () => {
  const source = readSource('src-tauri/src/cmd/secure_session.rs')

  assert.match(
    source,
    /const VAULT_SERVICE: &str = "com\.xxlink\.desktop\.secure-session"/,
    'vault service changed; the uninstaller target in installer.nsi must change with it',
  )
  for (const account of [
    /const VAULT_ACCOUNT: &str = "primary"/,
    /const VAULT_LOGOUT_MARKER_ACCOUNT: &str = "logout-pending"/,
  ]) {
    assert.match(
      source,
      account,
      'vault account changed; the uninstaller targets in installer.nsi must change with it',
    )
  }

  assert.match(
    source,
    /delete_credential_internal\(\)\.await/,
    'logout no longer deletes the credential',
  )
})
