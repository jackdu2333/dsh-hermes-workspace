import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { PACKAGE_NAME, PANEL_ID, REMOTE_NAMESPACE } from '../shared/constants'
import { GatewayTransport } from './gatewayRemote'
import type {
  BotProfile,
  BotRoster,
  ChatMessage,
  EventsPage,
  GatewayStatus,
  InterruptResult,
  OpenRequest,
  PingResult,
  PromptResult,
  ResumeResult,
} from '../shared/dto'

type HostContext = {
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void }
  effect: (callback: () => () => void, label?: string) => () => void
  get?: (name: string) => unknown
}

interface GatewayConfig {
  sshHost: string
  sshPort: number
  sshUser: string
}

interface RpcProfileRow {
  name?: unknown
  display_name?: unknown
  is_default?: unknown
  model?: unknown
  description?: unknown
  canonical_session?: { id?: unknown } | null
}

interface RpcMessageRow {
  role?: unknown
  content?: unknown
  message_uid?: unknown
  row_id?: unknown
  timestamp?: unknown
}

interface RpcResumeResult {
  session_id?: unknown
  messages?: RpcMessageRow[]
  message_count?: unknown
  running?: unknown
  open_requests?: unknown[]
  subscription_id?: unknown
  execution_generation?: unknown
}

export const Config = Schema.object({
  sshHost: Schema.string().default('127.0.0.1').description('Hermes 所在机器的 SSH 地址'),
  sshPort: Schema.number().default(22222).description('Hermes 所在机器的 SSH 端口'),
  sshUser: Schema.string().default('jackdu').description('运行 Hermes 的系统用户'),
})

/** 把 Gateway 的 content（字符串或结构化 parts）收敛成展示文本。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '')
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export class HermesBridgeService extends TypertRemoteService {
  static inject = [] as const
  static Config = Config
  private readonly transport: GatewayTransport

  constructor(ctx: HostContext, config: Partial<GatewayConfig> = {}) {
    super(ctx as never, REMOTE_NAMESPACE)
    this.transport = new GatewayTransport({
      host: typeof config.sshHost === 'string' && config.sshHost ? config.sshHost : '127.0.0.1',
      port: typeof config.sshPort === 'number' ? config.sshPort : 22222,
      user: typeof config.sshUser === 'string' && config.sshUser ? config.sshUser : 'jackdu',
    })
    ctx.logger?.info?.('hermes-workspace: gateway bridge started')
    void this.transport.connect().catch(error => {
      ctx.logger?.warn?.('hermes-workspace: initial gateway connect failed: %o', error)
    })
    ctx.effect(() => () => {
      this.transport.close()
      ctx.logger?.info?.('hermes-workspace: gateway bridge disposed')
    }, 'hermes-workspace: dispose')
  }

  async ping(): Promise<PingResult> {
    return { ok: true, plugin: PACKAGE_NAME, panelId: PANEL_ID, at: Date.now() }
  }

  async getConnectionStatus(): Promise<GatewayStatus> {
    return this.transport.status
  }

  async getBotRoster(): Promise<BotRoster> {
    const raw = await this.transport.rpc<{ profiles?: RpcProfileRow[]; bot_mode_protocol?: unknown }>(
      'profiles.list', { include_sessions: true },
    )
    const profiles: BotProfile[] = (raw.profiles ?? []).map(row => ({
      name: String(row.name ?? ''),
      displayName: String(row.display_name ?? row.name ?? ''),
      isDefault: Boolean(row.is_default),
      model: String(row.model ?? ''),
      description: String(row.description ?? ''),
      canonicalSessionId: row.canonical_session?.id ? String(row.canonical_session.id) : undefined,
    }))
    return { profiles, botModeProtocol: Boolean(raw.bot_mode_protocol) }
  }

  async resumeSession(request: { sessionId: string }): Promise<ResumeResult> {
    const sessionId = request.sessionId.trim()
    if (!sessionId) throw new Error('缺少 sessionId')
    const raw = await this.transport.rpc<RpcResumeResult>('session.resume', {
      session_id: sessionId,
      defer_history: true,
    })
    const messages: ChatMessage[] = (raw.messages ?? []).map((row, index) => ({
      id: String(row.message_uid ?? row.row_id ?? index),
      role: String(row.role ?? 'unknown'),
      text: extractText(row.content),
      timestamp: row.timestamp == null ? undefined : String(row.timestamp),
    }))
    return {
      sessionId: String(raw.session_id ?? sessionId),
      messages,
      messageCount: typeof raw.message_count === 'number' ? raw.message_count : messages.length,
      running: Boolean(raw.running),
      openRequests: (raw.open_requests ?? []) as OpenRequest[],
      subscriptionId: raw.subscription_id == null ? undefined : String(raw.subscription_id),
      executionGeneration: typeof raw.execution_generation === 'number' ? raw.execution_generation : undefined,
    }
  }

  /** 写入操作：仅在用户点击发送时调用，插件启动与恢复会话都不会自动发消息。
   *  Gateway 的 admission gate 要求每次提交带唯一的 submission_id（官方 Desktop 同样自动补 UUID）。 */
  async submitPrompt(request: { sessionId: string; text: string }): Promise<PromptResult> {
    const sessionId = request.sessionId.trim()
    const text = request.text.trim()
    if (!sessionId || !text) return { accepted: false, errorMessage: '会话或消息为空' }
    try {
      await this.transport.rpc('prompt.submit', {
        session_id: sessionId,
        text,
        submission_id: randomUUID(),
      })
      return { accepted: true }
    } catch (error) {
      return { accepted: false, errorMessage: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 写入操作：仅在用户点击中断时调用。execution_generation 由 session.resume 返回，
   *  不回传会被 Gateway 判为 stale_generation 并拒绝。 */
  async interruptSession(request: { sessionId: string; executionGeneration?: number }): Promise<InterruptResult> {
    const sessionId = request.sessionId.trim()
    if (!sessionId) return { accepted: false, errorMessage: '缺少 sessionId' }
    if (typeof request.executionGeneration !== 'number') {
      return { accepted: false, errorMessage: '缺少执行代次，请先恢复会话' }
    }
    try {
      await this.transport.rpc('session.interrupt', {
        session_id: sessionId,
        execution_generation: request.executionGeneration,
      })
      return { accepted: true }
    } catch (error) {
      return { accepted: false, errorMessage: error instanceof Error ? error.message : String(error) }
    }
  }

  async getEvents(): Promise<EventsPage> {
    return { events: this.transport.drainEvents() }
  }
}

const prototype = HermesBridgeService.prototype as unknown as Record<string, (...args: never[]) => Promise<unknown>>
for (const name of [
  'ping',
  'getConnectionStatus',
  'getBotRoster',
  'resumeSession',
  'submitPrompt',
  'interruptSession',
  'getEvents',
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
