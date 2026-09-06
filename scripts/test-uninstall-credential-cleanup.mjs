import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..')

const readSource = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), 'utf8')

// PROVES:         that certain exact strings DO appear, and one exact line does
//                 NOT appear, at the head of a line in
//                 src-tauri/packages/windows/installer.nsi; and that the file
//                 contains no /* block comment, which the other assertions
//                 assume. Its scope is uninstall behaviour: the credential
//                 vault, the reinstall launches, absolute program paths, and
//                 the exit code a failed service removal reports.
// DOES NOT PROVE: that any line compiles, that any branch runs, that any
//                 command executes, that the credential is gone, or that a
//                 managed uninstall observes the exit code. Proof of effect is
//                 the bundler's NSIS compile in CI and the C3 VM uninstall
//                 test; this file is a tripwire, not evidence. Nothing here
//                 runs in CI either -- frontend-check.yml:113 executes two
//                 guard scripts and this is not one of them.
//
// Assertions are anchored with ^[ \t]* against the RAW file. A previous
// revision hand-wrote an NSIS comment stripper so it could search anywhere in
// the line; the stripper disagreed with makensis in four places in seven lines,
// in both directions, and one of those let the uninstaller ship with no
// credential deletion at all while every assertion here stayed green. Anchoring
// needs no tokenizer: nothing preceded by ";", "#" or a DetailPrint can satisfy
// it, and there is no second lexer to drift from the first. Two assertions do
// build their own regex rather than going through `atLineStart` -- the
// exit-code pair, which needs a closing anchor that `atLineStart` would escape
// into a literal. That is a second MATCHER, not a second lexer: it is the same
// line-head anchoring with an added end anchor, and it is written out here
// because an earlier version of this paragraph claimed there was no second one
// at all.
const atLineStart = (literal) =>
  new RegExp('^[ \\t]*' + literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm')

// One line instead of a tokenizer. NSIS supports /* */ (verified with makensis),
// so a block comment around the cleanup would satisfy every line-anchored
// assertion below while the code never runs. This file uses block comments zero
// times, so requiring that stays true costs nothing and closes the hole without
// anything having to understand NSIS. If a block comment is ever wanted here,
// this fails loudly and that becomes a decision rather than an accident.
test('installer.nsi uses no block comments, which the assertions below assume', () => {
  const nsi = readSource('src-tauri/packages/windows/installer.nsi')
  assert.equal(
    (nsi.match(/\/\*/g) ?? []).length,
    0,
    'a /* */ block can hide live code from every line-anchored assertion in this file',
  )
})

// The session tokens are keyring entries in Windows Credential Manager, not
// files under $APPDATA. "Delete app data" removed the directories and left the
// credential, so a user who uninstalled kept a live token on the machine
// permanently -- and the same held for a logout interrupted before its delete
// step, which persists the secret under the logout-pending account. These
// assertions exist because the leak was invisible from the filesystem: an
// acceptance test that only inspects $APPDATA passes while the token remains.
test('uninstaller clears the credential vault when app data is deleted', () => {
  const nsi = readSource('src-tauri/packages/windows/installer.nsi')

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
    assert.match(
      nsi,
      atLineStart(`nsExec::Exec '"$SYSDIR\\cmdkey.exe" ${target}'`),
      `uninstaller does not clear "${account}.${service}" in the elevated context`,
    )
    assert.match(
      nsi,
      atLineStart(
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
  const executable = readSource('src-tauri/packages/windows/installer.nsi')
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

test('a failed service removal does not exit with the code that means cancelled', () => {
  // The uninstaller's exit code is read by this same installer's reinstall
  // path, where 1 means "user cancelled" and Aborts BEFORE the branch that
  // shows an error. A removal failure exiting 1 is therefore shown to the user
  // as a cancellation and to a managed uninstall as nothing at all -- the
  // silent success the SetErrorLevel line was added to prevent. 2 is what the
  // file already uses for its own failures.
  const nsi = readSource('src-tauri/packages/windows/installer.nsi')
  // Anchored at both ends, so this is the whole line and not a prefix of
  // 'SetErrorLevel 10'. atLineStart escapes metacharacters, so the closing
  // anchor cannot go through it.
  assert.equal(
    new RegExp('^[ \\t]*SetErrorLevel 1[ \\t]*$', 'm').test(nsi),
    false,
    'installer.nsi exits 1 on a service-removal failure, which its own reinstall path reads as user-cancelled',
  )
  assert.ok(
    new RegExp('^[ \\t]*SetErrorLevel 2[ \\t]*$', 'm').test(nsi),
    'installer.nsi no longer reports a service-removal failure through the exit code at all',
  )
})

test('every external program is invoked by an absolute path', () => {
  const executable = readSource('src-tauri/packages/windows/installer.nsi')

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
  // Anchored at the head of a line for the same reason as the assertions above:
  // an NSIS comment starts with ";" or "#", so `^[ \t]*` excludes it without a
  // stripper. Unanchored, this scan reported the prose line
  // "; ExecWait failed, set fake exit code" as a bare invocation -- a guard that
  // cries wolf on its own source is one people learn to switch off.
  const CALL =
    /^[ \t]*(?:nsExec::Exec(?:ToLog|ToStack)?|nsis_tauri_utils::RunAsUser|ExecShellWait|ExecShell|ExecWait|Exec)[^\S\r\n]+(.*)/gm
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
