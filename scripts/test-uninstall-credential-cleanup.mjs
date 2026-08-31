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
  for (const account of ['primary', 'logout-pending']) {
    assert.ok(
      nsi.includes(`cmdkey /delete:${account}.\${BUNDLEID}.secure-session`),
      `uninstaller does not delete the "${account}" credential entry`,
    )
  }

  // Written in terms of BUNDLEID rather than a literal identifier: a bundle id
  // change would otherwise leave these pointing at a target that no longer
  // exists, which fails silently because cmdkey also exits non-zero when the
  // target is simply absent.
  assert.equal(
    /cmdkey \/delete:[a-z-]+\.com\.xxlink\.desktop\.secure-session/.test(nsi),
    false,
    'credential targets are hardcoded; use ${BUNDLEID} so a bundle id change cannot silently orphan them',
  )

  // The deletion has to sit inside the delete-app-data branch. Outside it, an
  // update or a plain uninstall would sign the user out as a side effect.
  const branchStart = nsi.indexOf('$DeleteAppDataCheckboxState = 1')
  assert.notEqual(branchStart, -1, 'delete-app-data branch not found')
  const branchEnd = nsi.indexOf('${EndIf}', branchStart)
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
