import i18n from 'i18next'
import { ReactNode, isValidElement } from 'react'

import {
  classifyClientError,
  reportSafeClientFailure,
  toSafeClientErrorMessage,
  type SafeClientFailureScope,
} from '@/services/safe-client-error'

type NoticeType = 'success' | 'error' | 'info'

export interface NoticeTranslationDescriptor {
  key: string
  params?: SafeNoticeParams
}

type SafeNoticeParam = number | boolean | null | undefined
type SafeNoticeParams = Record<string, SafeNoticeParam>

export interface NoticeItem {
  readonly id: number
  readonly type: NoticeType
  readonly duration: number
  readonly message?: ReactNode
  readonly i18n?: NoticeTranslationDescriptor
  timerId?: ReturnType<typeof setTimeout>
}

type NoticeContent = ReactNode | NoticeTranslationDescriptor

type NoticeExtra = SafeNoticeParams | number | undefined

type NoticeShortcut = (
  message: NoticeContent,
  ...extras: NoticeExtra[]
) => number

type ShowNotice = ((
  type: NoticeType,
  message: NoticeContent,
  ...extras: NoticeExtra[]
) => number) & {
  success: NoticeShortcut
  error: NoticeShortcut
  info: NoticeShortcut
}

type NoticeSubscriber = () => void

const DEFAULT_DURATIONS: Readonly<Record<NoticeType, number>> = {
  success: 3000,
  info: 5000,
  error: 8000,
}

const TRANSLATION_KEY_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/

let nextId = 0
let notices: NoticeItem[] = []
const subscribers: Set<NoticeSubscriber> = new Set()

function notifySubscribers() {
  subscribers.forEach((subscriber) => subscriber())
}

interface ParsedNoticeExtras {
  params?: SafeNoticeParams
  duration?: number
  unsafe: boolean
}

function parseNoticeExtras(extras: NoticeExtra[]): ParsedNoticeExtras {
  let params: SafeNoticeParams | undefined
  let duration: number | undefined
  let unsafe = false

  for (const extra of extras) {
    if (extra === undefined) continue

    if (typeof extra === 'number' && duration === undefined) {
      duration = extra
      continue
    }

    if (isSafeNoticeParams(extra)) {
      if (!params) {
        params = extra
        continue
      }
      unsafe = true
      continue
    }

    unsafe = true
  }

  return { params, duration, unsafe }
}

function resolveDuration(type: NoticeType, override?: number) {
  return override ?? DEFAULT_DURATIONS[type]
}

function buildNotice(
  id: number,
  type: NoticeType,
  duration: number,
  payload: { message?: ReactNode; i18n?: NoticeTranslationDescriptor },
  timerId?: ReturnType<typeof setTimeout>,
): NoticeItem {
  return {
    id,
    type,
    duration,
    timerId,
    ...payload,
  }
}

function isMaybeTranslationDescriptor(
  message: unknown,
): message is NoticeTranslationDescriptor {
  if (
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    !isValidElement(message)
  ) {
    return typeof (message as Record<string, unknown>).key === 'string'
  }
  return false
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Error ||
    isValidElement(value)
  ) {
    return false
  }

  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isSafeNoticeParams(value: unknown): value is SafeNoticeParams {
  if (!isPlainRecord(value)) return false
  return Object.values(value).every(
    (item) =>
      item === null ||
      item === undefined ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item)),
  )
}

function isLikelyTranslationKey(key: string) {
  return TRANSLATION_KEY_PATTERN.test(key)
}

function shouldUseTranslationKey(key: string, params?: SafeNoticeParams) {
  if (params && Object.keys(params).length > 0) return true
  if (isLikelyTranslationKey(key)) return true
  if (i18n.isInitialized) {
    return i18n.exists(key)
  }
  return false
}

function extractDisplayText(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined
  if (typeof input === 'string') return input
  if (typeof input === 'number' || typeof input === 'boolean') {
    return String(input)
  }
  return undefined
}

const GENERIC_ERROR_NOTICE: NoticeTranslationDescriptor = {
  key: 'shared.feedback.errors.safeClient.unknown',
}

function normalizeNoticeMessage(
  message: NoticeContent,
  params?: SafeNoticeParams,
  unsafe = false,
): { message?: ReactNode; i18n?: NoticeTranslationDescriptor } {
  if (unsafe) return { i18n: GENERIC_ERROR_NOTICE }

  if (isValidElement(message)) {
    return { message }
  }

  if (isMaybeTranslationDescriptor(message)) {
    if (message.params && !isSafeNoticeParams(message.params)) {
      return { i18n: GENERIC_ERROR_NOTICE }
    }
    const originalParams = message.params ?? {}
    const mergedParams = Object.keys(params ?? {}).length
      ? { ...originalParams, ...params }
      : { ...originalParams }

    return {
      i18n: {
        key: message.key,
        params: Object.keys(mergedParams).length ? mergedParams : undefined,
      },
    }
  }

  if (typeof message === 'string') {
    if (shouldUseTranslationKey(message, params)) {
      return {
        i18n: {
          key: message,
          params: params && Object.keys(params).length ? params : undefined,
        },
      }
    }
    return { message }
  }

  return { i18n: GENERIC_ERROR_NOTICE }
}

const baseShowNotice = (
  type: NoticeType,
  message: NoticeContent,
  ...extras: NoticeExtra[]
): number => {
  const id = nextId++
  const { params, duration, unsafe } = parseNoticeExtras(extras)
  const effectiveDuration = resolveDuration(type, duration)
  const timerId =
    effectiveDuration > 0
      ? setTimeout(() => hideNotice(id), effectiveDuration)
      : undefined

  const normalizedMessage = normalizeNoticeMessage(message, params, unsafe)
  const notice = buildNotice(
    id,
    type,
    effectiveDuration,
    normalizedMessage,
    timerId,
  )

  notices = [...notices, notice]
  notifySubscribers()
  return id
}

/**
 * Shows a global notice; `showNotice.success / error / info` are the usual entry points.
 *
 * - `message`: localized safe string, i18n key, `{ key, params }`, or ReactNode
 * - `extras`: optional i18n params and duration (ms, 0 = persistent)
 * - Unsupported runtime values map to a generic error instead of being inspected
 * - Returns a notice id for manual closing via `hideNotice(id)`
 *
 * @example showNotice.success("profiles.page.feedback.notifications.batchDeleted");
 * @example showNotice.error("shared.feedback.errors.safeClient.unknown");
 * @example showNotice.error({ key: "profiles.page.feedback.errors.invalidUrl" }, 4000);
 */
export const showNotice: ShowNotice = Object.assign(baseShowNotice, {
  success: (message: NoticeContent, ...extras: NoticeExtra[]) =>
    baseShowNotice('success', message, ...extras),
  error: (message: NoticeContent, ...extras: NoticeExtra[]) =>
    baseShowNotice('error', message, ...extras),
  info: (message: NoticeContent, ...extras: NoticeExtra[]) =>
    baseShowNotice('info', message, ...extras),
})

export function showSafeClientFailureNotice(
  scope: SafeClientFailureScope,
  error: unknown,
): number {
  const { kind } = classifyClientError(error)
  reportSafeClientFailure(scope, error)
  return showNotice.error(toSafeClientErrorMessage(kind, (key) => key))
}

export function resolveNoticeCopyText(
  notice: NoticeItem,
  resolvedMessage: unknown,
  safeErrorText: string,
): string | undefined {
  if (notice.type === 'error') {
    return safeErrorText
  }

  return (
    extractDisplayText(resolvedMessage) ?? extractDisplayText(notice.message)
  )
}

export async function copyNoticeToClipboard(
  notice: NoticeItem,
  resolvedMessage: unknown,
  safeErrorText: string,
  writeText: (text: string) => Promise<void>,
): Promise<boolean> {
  const text = resolveNoticeCopyText(notice, resolvedMessage, safeErrorText)
  if (!text) return false
  await writeText(text)
  return true
}

export function hideNotice(id: number) {
  const notice = notices.find((candidate) => candidate.id === id)
  if (notice?.timerId) {
    clearTimeout(notice.timerId)
  }
  notices = notices.filter((candidate) => candidate.id !== id)
  notifySubscribers()
}

export function subscribeNotices(subscriber: NoticeSubscriber) {
  subscribers.add(subscriber)
  return () => {
    subscribers.delete(subscriber)
  }
}

export function getSnapshotNotices() {
  return notices
}
