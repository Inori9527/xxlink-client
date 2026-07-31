let accountRefreshQueue: Promise<void> = Promise.resolve()

/**
 * Serializes account-state reads and their local commits. The current backend
 * endpoints do not expose a shared snapshot revision, so allowing independent
 * pages and heartbeat refreshes to commit out of order can regress newer state.
 */
export async function runAccountRefreshExclusive<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = accountRefreshQueue.catch(() => undefined)
  let release!: () => void
  const turn = new Promise<void>((resolve) => {
    release = resolve
  })

  accountRefreshQueue = previous.then(() => turn)
  await previous

  try {
    return await operation()
  } finally {
    release()
  }
}
