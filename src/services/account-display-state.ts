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
