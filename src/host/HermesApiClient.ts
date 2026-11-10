import { joinUrl } from './url'

export class HermesHttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code ?? mapStatus(status)
  }
}

function mapStatus(status: number): string {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'incompatible'
  if (status === 0) return 'offline'
  return 'offline'
}

export class HermesApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
  ) {}

  async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.token) {
      headers['X-Hermes-Session-Token'] = this.token
      headers.Authorization = `Bearer ${this.token}`
    }
    let response: Response
    try {
      response = await fetch(joinUrl(this.baseUrl, path), { headers, signal, redirect: 'error' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new HermesHttpError(0, message.includes('ECONNREFUSED')
        ? 'Hermes dashboard 未启动，或 SSH 隧道本地端口已变化'
        : `无法连接 Hermes：${message}`, 'offline')
    }
    const text = await response.text()
    if (!response.ok) {
      throw new HermesHttpError(response.status, userMessage(response.status, text))
    }
    if (!text) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new HermesHttpError(response.status, 'Hermes 返回了无法解析的 JSON', 'incompatible')
    }
  }
}

function userMessage(status: number, body: string): string {
  if (status === 401 || status === 403) return 'Token 无效或未配置。请粘贴 Hermes Desktop 当前 dashboard token。'
  if (status === 404) return '当前入口不是 Hermes dashboard，或路径不匹配。'
  const snippet = body.replace(/\s+/g, ' ').slice(0, 180)
  return snippet || `Hermes 返回 HTTP ${status}`
}
