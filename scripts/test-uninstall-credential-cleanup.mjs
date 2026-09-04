import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..')

const readSource = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), 'utf8')

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

  for (const account of [primary, pending]) {
    assert.ok(
      nsi.includes(`cmdkey /delete:${account}.${service}`),
      `uninstaller does not delete the "${account}.${service}" credential entry`,
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

  // The deletion has to sit inside the delete-app-data branch. Outside it, an
  // update or a plain uninstall would sign the user out as a side effect.
  //
  // Delimit by the branch's own indentation rather than by the first
  // terminator. The block contains nested conditionals -- the per-profile
  // AppData sweep -- and an earlier version of this assertion stopped at the
  // first one it saw and reported the deletion as "outside the branch" while
  // it sat inside a nested block. The line-ending is detected because the repo
  // checks .nsi out with CRLF, and an LF-only needle silently never matches:
  // the assertion would then fail for a reason unrelated to what it checks.
  const branchStart = nsi.indexOf('$DeleteAppDataCheckboxState = 1')
  assert.notEqual(branchStart, -1, 'delete-app-data branch not found')
  const eol = nsi.includes('\r\n') ? '\r\n' : '\n'
  const terminator = `${eol}  \${EndIf}`
  const branchEnd = nsi.indexOf(terminator, branchStart)
  assert.notEqual(branchEnd, -1, 'delete-app-data branch has no terminator')
  const branch = nsi.slice(branchStart, branchEnd)
  assert.ok(
    branch.includes('cmdkey /delete:primary'),
    'credential deletion is outside the delete-app-data branch',
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
