import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { PACKAGE_NAME, PANEL_ID, REMOTE_NAMESPACE } from '../shared/constants'
import type {
  ChatMessage,
  ConnectionConfig,
  ConnectionStatus,
  MessagePage,
  PingResult,
  SaveResult,
  SessionPage,
  SessionSummary,
} from '../shared/dto'
import { discoverHermesDesktop } from './discover'
import { HermesApiClient, HermesHttpError } from './HermesApiClient'
import { HermesCredentialStore } from './HermesCredentialStore'
import { normalizeBaseUrl } from './url'

type HostContext = {
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void }
  effect: (callback: () => () => void, label?: string) => () => void
  get?: (name: string) => unknown
  credentials?: ConstructorParameters<typeof HermesCredentialStore>[0]
}

export const Config = Schema.object({
  baseUrl: Schema.string().default('').description('Hermes dashboard URL，例如 http://127.0.0.1:59585'),
  displayName: Schema.string().default('Hermes'),
  profile: Schema.string().default('default'),
})

export class HermesBridgeService extends TypertRemoteService {
  static inject = ['credentials'] as const
  static Config = Config
  private readonly credentials: HermesCredentialStore
  private readonly rowConfig: ConnectionConfig

  constructor(ctx: HostContext, config: Partial<ConnectionConfig> = {}) {
    super(ctx as never, REMOTE_NAMESPACE)
    this.rowConfig = {
      baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
      displayName: typeof config.displayName === 'string' && config.displayName.trim() ? config.displayName : 'Hermes',
      profile: typeof config.profile === 'string' ? config.profile : 'default',
    }
    this.credentials = new HermesCredentialStore(ctx.credentials ?? (ctx.get?.('credentials') as never))
    ctx.logger?.info?.('hermes-workspace: host bridge started')
    ctx.effect(() => () => {
      ctx.logger?.info?.('hermes-workspace: host bridge disposed')
    }, 'hermes-workspace: dispose')
  }

  async ping(): Promise<PingResult> {
    return { ok: true, plugin: PACKAGE_NAME, panelId: PANEL_ID, at: Date.now() }
  }

  async getConnectionStatus(): Promise<ConnectionStatus> {
    const config = await this.resolveConfig()
    const hasToken = await this.credentials.hasToken()
    if (!config.baseUrl) {
      return {
        state: 'unconfigured',
        displayName: config.displayName,
        profile: config.profile,
        hasToken,
        errorCode: 'unconfigured',
        errorMessage: '还没有可用的 dashboard 地址。先打开 Hermes Desktop 连上 SSH，或手动填写当前转发端口。',
      }
    }
    return this.probe(config, hasToken)
  }

  async saveConnectionConfig(request: ConnectionConfig): Promise<SaveResult> {
    const baseUrl = normalizeBaseUrl(request.baseUrl)
    const next = {
      baseUrl,
      displayName: request.displayName.trim() || 'Hermes',
      profile: request.profile.trim() || 'default',
    }
    await this.credentials.saveConnection(next)
    return { ok: true }
  }

  async saveApiKey(request: { token: string }): Promise<SaveResult> {
    await this.credentials.saveToken(request.token)
    return { ok: true }
  }

  async testConnection(): Promise<ConnectionStatus> {
    return this.getConnectionStatus()
  }

  async listSessions(): Promise<SessionPage> {
    const { client, profile } = await this.requireClient()
    const query = new URLSearchParams({ limit: '40', offset: '0', order: 'recent', archived: 'exclude' })
    if (profile) query.set('profile', profile)
    const raw = await client.getJson<Record<string, unknown>>(`/api/sessions?${query}`)
    const rows = Array.isArray(raw.sessions) ? raw.sessions : []
    const sessions: SessionSummary[] = rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return []
      const item = row as Record<string, unknown>
      const id = String(item.id ?? item.session_id ?? '')
      if (!id) return []
      return [{
        id,
        title: String(item.title ?? item.name ?? id),
        source: typeof item.source === 'string' ? item.source : undefined,
        updatedAt: String(item.updated_at ?? item.updatedAt ?? item.last_activity ?? ''),
        messageCount: typeof item.message_count === 'number' ? item.message_count : undefined,
      }]
    })
    return { sessions, total: typeof raw.total === 'number' ? raw.total : sessions.length }
  }

  async getSessionMessages(request: { sessionId: string }): Promise<MessagePage> {
    const sessionId = request.sessionId.trim()
    if (!sessionId) throw new Error('缺少 sessionId')
    const { client, profile } = await this.requireClient()
    const query = new URLSearchParams({ limit: '80', order: 'latest' })
    if (profile) query.set('profile', profile)
    const raw = await client.getJson<Record<string, unknown>>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?${query}`,
    )
    const rows = Array.isArray(raw.messages) ? raw.messages : []
    const messages: ChatMessage[] = rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return []
      const item = row as Record<string, unknown>
      return [{
        id: String(item.id ?? item.message_id ?? `${item.role ?? 'unknown'}`),
        role: String(item.role ?? item.type ?? 'unknown'),
        text: extractText(item),
      }]
    }).reverse()
    return { sessionId: String(raw.session_id ?? sessionId), messages }
  }

  private async resolveConfig(): Promise<ConnectionConfig> {
    const saved = await this.credentials.readConnection()
    const discovered = await discoverHermesDesktop().catch(() => undefined)
    const token = await this.credentials.readToken()
    if (!token && discovered?.token) {
      await this.credentials.saveToken(discovered.token)
    }
    const baseUrl = saved.baseUrl || discovered?.baseUrl || this.rowConfig.baseUrl
    return {
      baseUrl,
      displayName: saved.displayName || discovered?.displayName || this.rowConfig.displayName || 'Hermes',
      profile: saved.profile || discovered?.profile || this.rowConfig.profile || 'default',
    }
  }

  private async probe(config: ConnectionConfig, hasToken: boolean): Promise<ConnectionStatus> {
    const token = await this.credentials.readToken()
    const client = new HermesApiClient(config.baseUrl, token)
    try {
      const health = await client.getJson<Record<string, unknown>>('/api/health')
      if (health.ok !== true) {
        return status(config, hasToken, 'incompatible', '当前入口没有返回 Hermes /api/health ok')
      }
      if (!token) {
        return status(config, true, 'unauthorized', '已连通 dashboard，但还没有 session token', String(health.displayVersion ?? health.version ?? ''))
      }
      await client.getJson('/api/auth/me')
      return status(config, true, 'online', undefined, String(health.displayVersion ?? health.version ?? ''))
    } catch (error) {
      return this.mapError(config, hasToken || Boolean(token), error)
    }
  }

  private mapError(config: ConnectionConfig, hasToken: boolean, error: unknown): ConnectionStatus {
    if (error instanceof HermesHttpError) {
      return status(config, hasToken, error.code as ConnectionStatus['state'], error.message)
    }
    const message = error instanceof Error ? error.message : String(error)
    return status(config, hasToken, 'offline', message)
  }

  private async requireClient(): Promise<{ client: HermesApiClient; profile: string }> {
    const config = await this.resolveConfig()
    if (!config.baseUrl) throw Object.assign(new Error('尚未配置 dashboard 地址'), { code: 'unconfigured' })
    const token = await this.credentials.readToken()
    if (!token) throw Object.assign(new Error('尚未保存 session token'), { code: 'unauthorized' })
    return { client: new HermesApiClient(config.baseUrl, token), profile: config.profile }
  }
}

function status(
  config: ConnectionConfig,
  hasToken: boolean,
  state: ConnectionStatus['state'],
  errorMessage?: string,
  version?: string,
): ConnectionStatus {
  return {
    state,
    displayName: config.displayName,
    profile: config.profile,
    baseUrl: config.baseUrl,
    version,
    lastCheckedAt: Date.now(),
    hasToken,
    errorCode: state === 'online' ? undefined : state,
    errorMessage,
  }
}

function extractText(item: Record<string, unknown>): string {
  if (typeof item.content === 'string') return item.content
  if (typeof item.text === 'string') return item.text
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) return String((part as { text?: unknown }).text ?? '')
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

const prototype = HermesBridgeService.prototype as unknown as Record<string, (...args: never[]) => Promise<unknown>>
for (const name of [
  'ping',
  'getConnectionStatus',
  'saveConnectionConfig',
  'saveApiKey',
  'testConnection',
  'listSessions',
  'getSessionMessages',
] as const) {
  ;(Remote(name) as (value: unknown, context: unknown) => void)(prototype[name], {
    name,
    private: false,
    static: false,
    addInitializer(fn: () => void) {
      fn.call(Object.create(prototype))
    },
  })
}
