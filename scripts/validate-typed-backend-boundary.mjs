import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(path, 'utf8')
const fail = (message) => {
  throw new Error(`[typed-backend-boundary] ${message}`)
}
const assert = (condition, message) => {
  if (!condition) fail(message)
}

const controller = read('src/services/backend-controller.ts')
const managedProfile = read('src/services/managed-subscription-profile.ts')
const legacyApi = read('src/services/api.ts')
const rustController = read('src-tauri/src/cmd/backend_controller.rs')
const secureSession = read('src-tauri/src/cmd/secure_session.rs')
const profileStore = read('src-tauri/src/config/profiles.rs')
const profileCommands = read('src-tauri/src/cmd/profile.rs')
const profileTimer = read('src-tauri/src/core/timer.rs')
const deepLinkResolver = read('src-tauri/src/utils/resolve/scheme.rs')
const fileHelpers = read('src-tauri/src/utils/help.rs')
const rendererConfig = read('src/services/config.ts')
const logoutDelete = secureSession.slice(
  secureSession.indexOf('pub async fn secure_session_delete'),
  secureSession.indexOf('async fn delete_credential_internal'),
)
const consumers = [
  'src/pages/connect.tsx',
  'src/pages/plans.tsx',
  'src/pages/mine.tsx',
  'src/components/mine/promo-redeem-panel.tsx',
  'src/services/resume-recovery.ts',
].map(read)

for (const forbidden of [
  'accessToken',
  'refreshToken',
  'Authorization',
  'subUrl',
]) {
  assert(
    !controller.includes(forbidden),
    `renderer controller exposes forbidden field: ${forbidden}`,
  )
}

assert(
  !/interface NodeView[\s\S]*?\b(host|port)\??:/.test(controller),
  'NodeView exposes a transport endpoint',
)
assert(
  controller.includes("'service_blocked'"),
  'service-blocked state is not represented',
)
assert(
  controller.includes("authStore.setSessionStatus('service_blocked')"),
  'service-blocked response does not preserve the signed-in shell state',
)
assert(
  controller.includes('SubjectBoundReply') &&
    controller.includes('isBackendSubjectCurrent(expectedSubject)') &&
    rustController.includes('SubjectBound<T>') &&
    rustController.includes('SubjectBoundError'),
  'typed backend results and failures are not bound to the active vault subject',
)

for (const forbidden of [
  'getSubUrl',
  'getProfiles',
  'importProfile',
  'patchProfile',
  'subUrl',
  '/subscription/',
]) {
  assert(
    !managedProfile.includes(forbidden),
    `managed profile adapter still handles sensitive material: ${forbidden}`,
  )
}
assert(
  managedProfile.includes('managed_subscription_sync') ||
    managedProfile.includes('syncManagedSubscription'),
  'managed profile adapter does not use the trusted command',
)

for (const method of ['subscription:', 'user:', 'promo:', 'nodes:']) {
  assert(
    !legacyApi.includes(method),
    `legacy renderer API still exposes migrated namespace: ${method}`,
  )
}
for (const forbidden of [
  'requireSecureSession',
  'replaceSecureSession',
  'Authorization',
  'createSubscriptionCheckout',
  '/payment/subscription/checkout',
  'apiKeys:',
  'traffic:',
]) {
  assert(
    !legacyApi.includes(forbidden),
    `legacy renderer API retains privileged transport: ${forbidden}`,
  )
}
assert(
  controller.includes("'backend_report_traffic'"),
  'traffic accounting still bypasses the trusted controller',
)

assert(
  rustController.includes('session_operation_guard().await') &&
    secureSession.includes('SESSION_OPERATION_LOCK'),
  'authenticated operations are not serialized with session replacement',
)
assert(
  rustController.includes('option_env!("VITE_API_BASE_URL")') &&
    !rustController.includes('XXLINK_API_BASE_URL') &&
    rendererConfig.includes('VITE_API_BASE_URL'),
  'trusted and renderer transports can resolve different configured API origins',
)
assert(
  rustController.includes('deactivate_managed_profiles().await') &&
    rustController.includes('CoreManager::global()') &&
    rustController.includes('.stop_core()'),
  'authoritative entitlement loss does not deactivate managed service',
)
assert(
  rustController.includes('from_local_detached') &&
    rustController.includes('remove_created_items(&created).await') &&
    rustController.includes('profiles_retire_items_safe(&managed)') &&
    rustController.includes('profiles_append_item_preserve_current_safe'),
  'managed profile replacement lacks detached staging or rollback cleanup',
)
const stopCoreIndex = rustController.indexOf('.stop_core()')
const deactivateProfilesIndex = rustController.indexOf(
  'profiles_deactivate_items_safe(&managed)',
)
assert(
  stopCoreIndex >= 0 &&
    deactivateProfilesIndex >= 0 &&
    stopCoreIndex < deactivateProfilesIndex,
  'authoritative deactivation can mutate profile metadata before stopping the managed core',
)
assert(
  rustController.includes('enforce_authoritative_service_block(kind).await') &&
    rustController.includes(
      'let _profile_switch_guard = crate::cmd::wait_priority_profile_switch_guard().await',
    ),
  'generic authoritative backend denials can bypass managed-service deactivation',
)
assert(
  rustController.includes('managed_profile_marker(subject_id)') &&
    rustController.includes(
      'deactivate_foreign_current_managed_profile(subject_id)',
    ) &&
    secureSession.includes('deactivate_managed_profiles()'),
  'account replacement can retain a managed profile owned by the previous subject',
)
assert(
  secureSession.includes('logout_pending = true') &&
    logoutDelete.indexOf('LOGOUT_REQUESTED.store(true') <
      logoutDelete.indexOf('session_operation_guard().await') &&
    secureSession.includes('secure_session_recover_pending_logout') &&
    secureSession.includes('filter(|value| !value.is_logout_pending())'),
  'pending logout credentials can remain usable or restore the renderer session',
)
assert(
  rustController.includes('try_profile_switch_guard') &&
    rustController.includes('patch_profiles_config_if_current_under_guard') &&
    profileStore.includes('cannot retire the current profile'),
  'managed profile activation/retirement is not guarded against concurrent selection changes',
)
assert(
  profileCommands.includes('struct ProfileSwitchGuard') &&
    profileCommands.includes('impl Drop for ProfileSwitchGuard') &&
    profileCommands.includes('patch_profiles_config_if_current_under_guard'),
  'profile activation CAS does not use an auto-releasing guard',
)
assert(
  profileTimer.includes('wait_profile_switch_guard().await') &&
    !profileTimer.includes('Skipping scheduled profile update'),
  'scheduled profile refresh can silently skip updates during guard contention',
)
assert(
  deepLinkResolver.includes('wait_profile_switch_guard().await') &&
    deepLinkResolver.includes('Semaphore::const_new(2)') &&
    deepLinkResolver.includes('DEEP_LINK_IMPORT_SLOTS.acquire().await') &&
    profileCommands.includes('PROFILE_SWITCH_RELEASED') &&
    profileCommands.includes('notify_waiters()'),
  'deep-link profile import can be discarded instead of waiting for the shared mutation guard',
)
assert(
  deepLinkResolver.indexOf('fetch_profile_item(url, name).await') <
    deepLinkResolver.indexOf('wait_profile_switch_guard().await'),
  'deep-link network fetch holds the profile mutation guard',
)
assert(
  profileStore.includes('help::atomic_write') &&
    fileHelpers.includes('recover_atomic_write') &&
    fileHelpers.includes('MOVEFILE_REPLACE_EXISTING'),
  'managed profile persistence is not crash-recoverable and atomic',
)
for (const constraint of [
  'MAX_BYTES_PER_REPORT',
  'MAX_CLOCK_SKEW_MILLIS',
  'node_id.len() > 100',
  'bytes_up.fract() != 0.0',
  'timestamp.fract() != 0.0',
]) {
  assert(
    rustController.includes(constraint),
    `traffic report validation is missing: ${constraint}`,
  )
}

for (const source of consumers) {
  for (const pattern of [
    /api\.subscription/,
    /api\.user/,
    /api\.promo/,
    /api\.nodes/,
    /api\.traffic/,
    /requireSecureSession/,
  ]) {
    assert(
      !pattern.test(source),
      `approved consumer bypasses typed controller: ${pattern}`,
    )
  }
}

console.log('Typed backend boundary validation passed.')
