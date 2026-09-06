import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..')

const readSource = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), 'utf8')

// PROVES:         that certain exact strings DO appear, and one exact line does
//                 NOT appear, at the head of a line in
//                 src-tauri/packages/windows/installer.nsi; that the lines
//                 BEGINNING with a launch instruction are exactly a reviewed list
//                 of fourteen, each of which names its program through an NSIS
//                 variable rather than a bare name the executable search order
//                 resolves; and
//                 that the file contains no /* block comment, which the
//                 other assertions assume. It also reads production Rust and Tauri
//                 configuration, not only installer text: removing
//                 delete_credential_internal().await from secure_session.rs fails
//                 the last test with installer.nsi untouched, and the vault
//                 constants are compared against tauri.conf.json's bundle identity.
//                 Its scope is uninstall behaviour: the credential vault, the
//                 reinstall launches, the program paths, and the exit code a failed
//                 removal reports.
// DOES NOT PROVE: that any line compiles, that any branch runs, that any
//                 command executes, that the credential is gone, or that a
//                 managed uninstall observes the exit code. Nor that those
//                 fourteen are EVERY launch in the file: a macro that expands to
//                 one, a launch after something else on the same line, or an
//                 !insertmacro that runs a program are invisible to a line-head
//                 finder, and closing that would need the NSIS grammar this file
//                 deliberately does not carry. installer.nsi:338-350 records the
//                 one known residual -- $R1 can hold a bare MsiExec.exe from the
//                 WiX branch. Proof of effect is
//                 the bundler's NSIS compile in CI and the C3 VM uninstall
//                 test; this file is a tripwire, not evidence. It DOES run in
//                 CI, via `pnpm test:consumer-continuity` in frontend-check.yml --
//                 an earlier version of this line said the opposite, from a grep
//                 that could not see a `pnpm test:` step.
//
// Assertions are anchored with ^[ \t]* against the RAW file. A previous
// revision hand-wrote an NSIS comment stripper so it could search anywhere in
// the line; the stripper disagreed with makensis in four places in seven lines,
// in both directions, and one of those let the uninstaller ship with no
// credential deletion at all while every assertion here stayed green. Anchoring
// needs no tokenizer: nothing preceded by ";", "#" or a DetailPrint can satisfy
// it. Two assertions build their own regex rather than going through
// `atLineStart` -- the exit-code pair, which needs a closing anchor that
// `atLineStart` would escape into a literal.
//
// There is no NSIS lexer in this file any more. There was one until this
// candidate: `operands()` in the launch-line test split each line character
// by character and decided which operand was the program. It did not know
// NSIS's $\" escape -- given
// `Exec "$\"cmd.exe$\" /c echo bypass"` it returned
// ["$\\", "cmd.exe$\\ /c echo bypass"] and read `$\` as the program,
// while makensis 3.11 compiles that line as `Exec: ""cmd.exe" /c echo bypass"`.
// Two earlier versions of this paragraph asserted no second lexer existed
// while that one sat forty lines below. It is deleted; the launch lines are
// enumerated against a reviewed list instead, and the regex that finds them
// makes no judgement about their contents.
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

// The launch lines are enumerated, not parsed. Until this candidate the
// assertion split each line into operands with a hand-written
// character-by-character scanner and decided which operand was the program.
// That scanner did not know NSIS's $\" escape: given
// `Exec "$\"cmd.exe$\" /c echo bypass"` it produced
// ["$\\", "cmd.exe$\\ /c echo bypass"] and read `$\` as the
// program, while makensis 3.11 compiles that same line as
// `Exec: ""cmd.exe" /c echo bypass"`. A second lexer that disagrees with the
// real one is the class M27 ordered out of these guards, and 326f8c51 had
// introduced this one inside the same batch that deleted the other.
//
// What replaces it: the regex still FINDS the launch lines -- that is
// line-head anchoring, the same thing atLineStart does, and it makes no
// judgement about their contents -- and the assertion is a deepEqual against
// the exact list below. Every entry was read once: each names its program
// through an NSIS variable or constant ($SYSDIR, $INSTDIR, $TEMP, or a
// register holding a path from the registry), never a bare name the
// executable search order would resolve. Adding, removing or editing any
// launch line fails this test, which is the point: that is a change a person
// should look at, and no scanner has to be right about NSIS for it to work.
const EXPECTED_LAUNCHES = [
  "ExecWait '$R1' $0",
  "ExecWait '$R1' $0",
  'nsis_tauri_utils::RunAsUser "$INSTDIR\\${MAINBINARYNAME}.exe" ""',
  'nsExec::ExecToLog \'"$INSTDIR\\resources\\xxlink-service-install.exe"\'',
  'ExecWait \'"$TEMP\\$VC_REDIST_EXE" /quiet /norestart\' $0',
  'ExecWait \'"$6" ${WEBVIEW2INSTALLERARGS} /install\' $1',
  'ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1',
  'nsExec::Exec \'"$SYSDIR\\netsh.exe" int tcp res\'',
  'nsis_tauri_utils::RunAsUser "$INSTDIR\\${MAINBINARYNAME}.exe" "$R0"',
  'nsis_tauri_utils::RunAsUser "$SYSDIR\\cmd.exe" \'/c rmdir /s /q "%APPDATA%\\${BUNDLEID}" & rmdir /s /q "%LOCALAPPDATA%\\${BUNDLEID}"\'',
  'nsExec::Exec \'"$SYSDIR\\cmdkey.exe" /delete:primary.com.xxlink.desktop.secure-session\'',
  'nsExec::Exec \'"$SYSDIR\\cmdkey.exe" /delete:logout-pending.com.xxlink.desktop.secure-session\'',
  'nsis_tauri_utils::RunAsUser "$SYSDIR\\cmdkey.exe" "/delete:primary.com.xxlink.desktop.secure-session"',
  'nsis_tauri_utils::RunAsUser "$SYSDIR\\cmdkey.exe" "/delete:logout-pending.com.xxlink.desktop.secure-session"',
]

// Longest first: `Exec` is a prefix of the other three, and leaving it out
// entirely was a real bypass -- `Exec 'cmdkey /list'` and
// `ExecShellWait "open" "cmdkey"` both launched a bare program past an
// earlier version of this scan while it reported the file clean. Anchored at
// the head of a line so an NSIS comment (";" or "#") cannot satisfy it:
// unanchored, it once reported the prose "; ExecWait failed, set fake exit
// code" as an invocation, and a guard that cries wolf on its own source is
// one people learn to switch off.
// The `i` flag is load-bearing, not tidiness: NSIS instructions are
// case-insensitive, and makensis 3.11 compiles `exec 'cmdkey /list'` at rc=0
// (measured). Without it the finder saw only the casing that happens to be
// in the file today, so a lower-case launch added later would never enter
// the snapshot and the deepEqual would stay green.
const LAUNCH_LINE =
  /^[ \t]*(?:nsExec::Exec(?:ToLog|ToStack)?|nsis_tauri_utils::RunAsUser|ExecShellWait|ExecShell|ExecWait|Exec)[^\S\r\n].*/gim

test('the launch lines in installer.nsi are exactly the reviewed set', () => {
  const nsi = readSource('src-tauri/packages/windows/installer.nsi')
  const found = [...nsi.matchAll(LAUNCH_LINE)].map((m) => m[0].trim())
  assert.deepEqual(
    found,
    EXPECTED_LAUNCHES,
    'installer.nsi launch lines changed; each one runs a program, so read the diff before updating this list',
  )
})

// Red-first, because a snapshot assertion is worthless if the finder misses
// the thing it is supposed to snapshot. A bare program name added to the
// file must show up as an extra entry rather than slipping past the regex.
test('a bare program name would appear in that set', () => {
  const nsi = readSource('src-tauri/packages/windows/installer.nsi')
  // Lower case on purpose: makensis accepts it, so the finder has to.
  const tampered = nsi + "\n  exec 'cmdkey /list'\n"
  const found = [...tampered.matchAll(LAUNCH_LINE)].map((m) => m[0].trim())
  assert.notDeepEqual(
    found,
    EXPECTED_LAUNCHES,
    'the finder does not see a bare Exec',
  )
  assert.ok(
    found.includes("exec 'cmdkey /list'"),
    'the finder missed a bare program name appended to the file',
  )
})

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
