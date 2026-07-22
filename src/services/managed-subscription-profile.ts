import { backendController } from '@/services/backend-controller'
import delayManager from '@/services/delay'

function clearLastSyncError(): void {
  try {
    localStorage.removeItem('xxlink:last-sync-error')
    window.dispatchEvent(new CustomEvent('xxlink:last-sync-error-changed'))
  } catch {
    // The trusted sync succeeded even when optional renderer storage is absent.
  }
}

function finishForcedRebuild(): void {
  try {
    localStorage.removeItem('clash-verge-selected-proxy-group')
    localStorage.removeItem('clash-verge-selected-proxy')
    localStorage.removeItem('clash-verge-proxy-sort-type')
    window.dispatchEvent(new CustomEvent('xxlink:subscription-resync'))
  } catch {
    // Runtime profile application remains authoritative.
  }
  delayManager.clearCache()
}

async function syncManagedSubscription(force: boolean): Promise<void> {
  await backendController.syncManagedSubscription(force)
  clearLastSyncError()
  if (force) finishForcedRebuild()
}

export async function ensureManagedSubscriptionProfile(): Promise<void> {
  await syncManagedSubscription(false)
}

export async function refreshManagedSubscriptionProfile(): Promise<void> {
  await syncManagedSubscription(false)
}

export async function rebuildManagedSubscriptionProfile(): Promise<void> {
  await syncManagedSubscription(true)
}
