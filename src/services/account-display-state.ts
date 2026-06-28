export function formatUsagePairLabel(input: {
  usageKnown: boolean
  usedLabel: string
  limitLabel?: string | null
  unknownLabel: string
}): string {
  if (!input.usageKnown) return input.unknownLabel
  return `${input.usedLabel} / ${input.limitLabel || '--'}`
}

export function shouldShowConfirmedEmptyPlans(input: {
  loading: boolean
  planCount: number
  loadFailed: boolean
}): boolean {
  return !input.loading && !input.loadFailed && input.planCount === 0
}

export function getAccountRefreshFailureState(input: {
  subscriptionFailed: boolean
  benefitFailed: boolean
  usageFailed: boolean
  nodesFailed: boolean
}): {
  accountDataRefreshFailed: boolean
  nodeListRefreshFailed: boolean
  anyRefreshFailed: boolean
} {
  const accountDataRefreshFailed =
    input.subscriptionFailed || input.benefitFailed || input.usageFailed
  return {
    accountDataRefreshFailed,
    nodeListRefreshFailed: input.nodesFailed,
    anyRefreshFailed: accountDataRefreshFailed || input.nodesFailed,
  }
}

export function shouldShowRefreshFailureNotice(input: {
  refreshFailed: boolean
  hasLastKnownGood: boolean
}): boolean {
  return input.refreshFailed && !input.hasLastKnownGood
}
