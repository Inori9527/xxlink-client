export type UnlistenFn = () => void

export interface TauriEvent<T> {
  event: string
  id: number
  payload: T
}

export type EventCallback<T = unknown> = (
  event: TauriEvent<T>,
) => void | Promise<void>

export const listen =
  async <T>(
    _eventName: string,
    _handler: EventCallback<T>,
  ): Promise<UnlistenFn> =>
  () =>
    undefined

export const once = listen

export const emit = async <T = unknown>(
  _eventName: string,
  _payload?: T,
): Promise<void> => undefined

export const event = { emit, listen, once }
