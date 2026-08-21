import { getPreviewNodeDelay, getPreviewProxies } from './preview-state'

export type Traffic = {
  up: number
  down: number
}

export type Message =
  | { type: 'Text'; data: string }
  | { type: 'Binary'; data: number[] }
  | { type: 'Ping'; data: number[] }
  | { type: 'Pong'; data: number[] }
  | { type: 'Close'; data: { code: number; reason: string } | null }

type MessageListener = (message: Message) => void

export const getProxies = async () => getPreviewProxies()

export const delayProxyByName = async (
  proxyName: string,
  _testUrl: string,
  _timeout: number,
) => ({ delay: getPreviewNodeDelay(proxyName) })

export class MihomoWebSocket {
  private static readonly instances = new Set<MihomoWebSocket>()

  private readonly listeners = new Set<MessageListener>()

  private closed = false

  private constructor() {
    MihomoWebSocket.instances.add(this)
  }

  static async connect_traffic(): Promise<MihomoWebSocket> {
    return new MihomoWebSocket()
  }

  static async connect_memory(): Promise<MihomoWebSocket> {
    return new MihomoWebSocket()
  }

  addListener(listener: MessageListener): () => void {
    if (this.closed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async close(): Promise<void> {
    this.closed = true
    this.listeners.clear()
    MihomoWebSocket.instances.delete(this)
  }

  static async cleanupAll(): Promise<void> {
    await Promise.all(
      Array.from(MihomoWebSocket.instances, (instance) => instance.close()),
    )
  }
}
