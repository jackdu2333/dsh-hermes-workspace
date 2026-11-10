import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { PACKAGE_NAME, PANEL_ID, REMOTE_NAMESPACE } from '../shared/constants'
import { GatewayTransport } from './gatewayRemote'
import { readDashboardToken, startDashboardProxy, type DashboardProxy } from './dashboardProxy'
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
  /** 本机 Hermes profile 名。 */
  profile: string
}

interface RpcProfileRow {
  name?: unknown
  display_name?: unknown
  is_default?: unknown
  model?: unknown
  description?: unknown
  canonical_session?: { id?: unknown } | null
  /** Bot 模式的展示名、主色与形象存在这里（`hermes-bots.*`），display_name 常年为空。 */
  ui_meta?: Record<string, { title?: unknown; color?: unknown } | null | undefined> | null
}

interface RpcMessageRow {
  role?: unknown
  content?: unknown
  /** role=tool 时由 gateway 填充；Client 用它显示工具名，而不是整段 JSON。 */
  tool_name?: unknown
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

/** canonical 会话的识别依据是**标题**：每个 profile 的 DB 里 title 唯一的 "Bot Chat"。
 *  官方 Bot 模式首次进入也走同一条规则，所以这里必须用完全相同的字面量。 */
const BOT_CHAT_TITLE = 'Bot Chat'

export const Config = Schema.object({
  profile: Schema.string().default('default').description('本机 Hermes profile 名'),
})

/** 流式渲染只关心这几类事件。`sessions.changed` / `platforms.changed` / `heartbeat` 是高频广播，
 *  在 180ms 的流式轮询下会把通道塞满、把真正的 delta 挤掉。 */
const STREAM_EVENT_TYPES = new Set([
  'message.start',
  'message.delta',
  'message.interim',
  'message.complete',
  'thinking.delta',
  'reasoning.delta',
  'reasoning.available',
  'tool.start',
  'tool.complete',
  'tool.generating',
  'tool.progress',
  'agent.step',
  'session.usage',
  'session.info',
  'error',
  'unsupported_request',
])

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
  private readonly hostCtx: HostContext
  private readonly defaultProfile: string
  /** Hermes 每个 profile 跑独立的 gateway 实例，WS 只能操作它自己那个 profile：
   *  拿 default 的连接去 resume `obsidian-notes` 的会话会被 gateway 判 profile_mismatch，
   *  连 profiles.list 都读不到别人的 canonical_session。所以按 profile 各留一条连接。 */
  private readonly transports = new Map<string, GatewayTransport>()
  private dashboardProxy?: DashboardProxy
  private dashboardOrigin?: string
  private proxyTarget?: string
  private proxyStarting = false

  constructor(ctx: HostContext, config: Partial<GatewayConfig> = {}) {
    super(ctx as never, REMOTE_NAMESPACE)
    this.hostCtx = ctx
    this.defaultProfile = typeof config.profile === 'string' && config.profile ? config.profile : 'default'
    // 预热默认连接：面板首屏的 profiles.list 与状态灯都靠它。
    void this.ensureOnline(this.transportFor(this.defaultProfile)).catch(error => {
      ctx.logger?.warn?.('hermes-workspace: initial gateway connect failed: %o', error)
    })
    ctx.logger?.info?.('hermes-workspace: gateway bridge started')
    ctx.effect(() => () => {
      for (const transport of this.transports.values()) transport.close()
      this.transports.clear()
      void this.dashboardProxy?.close().catch(() => undefined)
      ctx.logger?.info?.('hermes-workspace: gateway bridge disposed')
    }, 'hermes-workspace: dispose')
  }

  /** 同一个 profile 复用同一条连接；不同 profile 互不干扰。 */
  private transportFor(profile?: string): GatewayTransport {
    const name = (profile ?? '').trim() || this.defaultProfile
    let transport = this.transports.get(name)
    if (!transport) {
      transport = new GatewayTransport({ profile: name })
      this.transports.set(name, transport)
    }
    return transport
  }

  /** `ensureConnected` 内部吞掉了异常（轮询场景不希望抛），这里靠状态回查把失败暴露给调用方。 */
  private async ensureOnline(transport: GatewayTransport): Promise<void> {
    if (transport.status.state === 'online') return
    await transport.ensureConnected(0)
    // 重新取一次快照：上一个 if 已经让 TS 把 state 收窄成「非 online」了。
    const status: GatewayStatus = transport.status
    if (status.state !== 'online') {
      throw new Error(status.errorMessage ?? 'Hermes gateway 未连接')
    }
  }

  /** 内嵌原生 Dashboard 需要 dashboard token，而它是进程内随机值；
   *  这里起一个 loopback 反代补上 `X-Hermes-Session-Token`，iframe 才能正常加载。
   *  代理失败只影响原生界面，不影响 RPC 通道。 */
  private async ensureDashboardProxy(apiOrigin: string): Promise<void> {
    if (this.proxyStarting) return
    if (this.proxyTarget === apiOrigin && this.dashboardProxy) return
    const token = readDashboardToken()
    if (!token) {
      // 标记已尝试，避免每 1.5 秒轮询都读一次 .env 并刷日志；apiOrigin 变化时会重试。
      this.proxyTarget = apiOrigin
      this.hostCtx.logger?.warn?.(
        'hermes-workspace: 未在 ~/.hermes/.env 配置 HERMES_DASHBOARD_SESSION_TOKEN，原生界面不可用',
      )
      return
    }
    this.proxyStarting = true
    try {
      await this.dashboardProxy?.close().catch(() => undefined)
      this.dashboardProxy = undefined
      this.dashboardOrigin = undefined
      const url = new URL(apiOrigin)
      const proxy = await startDashboardProxy(
        { host: url.hostname, port: Number(url.port || 80) },
        token,
      )
      this.dashboardProxy = proxy
      this.dashboardOrigin = proxy.origin
      this.proxyTarget = apiOrigin
      this.hostCtx.logger?.info?.(`hermes-workspace: dashboard proxy ready at ${proxy.origin}`)
    } catch (error) {
      this.hostCtx.logger?.warn?.('hermes-workspace: dashboard proxy failed: %o', error)
    } finally {
      this.proxyStarting = false
    }
  }

  async ping(): Promise<PingResult> {
    return { ok: true, plugin: PACKAGE_NAME, panelId: PANEL_ID, at: Date.now() }
  }

  /** 状态灯反映的是「当前正在看的那个 Bot」的连接，而不是默认 profile 的。 */
  async getConnectionStatus(request?: { profile?: string }): Promise<GatewayStatus> {
    const transport = this.transportFor(request?.profile)
    void transport.ensureConnected()
    const status = transport.status
    if (status.state === 'online' && status.apiOrigin) {
      await this.ensureDashboardProxy(status.apiOrigin)
    }
    return { ...status, dashboardOrigin: this.dashboardOrigin }
  }

  /** 只列 profile 目录，不逐个握手：N 个 Bot 拉起 N 个 gateway 太重。
   *  canonical_session 也只在「该 profile 自己的连接」里才读得准，所以这里不再拿它判断可点性，
   *  真正的会话解析推迟到用户点开某个 Bot 时（openBot）。 */
  async getBotRoster(): Promise<BotRoster> {
    const transport = this.transportFor(this.defaultProfile)
    await this.ensureOnline(transport)
    const raw = await transport.rpc<{ profiles?: RpcProfileRow[]; bot_mode_protocol?: unknown }>(
      'profiles.list', { include_sessions: true },
    )
    const profiles: BotProfile[] = (raw.profiles ?? []).map(row => {
      const botMeta = row.ui_meta?.['hermes-bots']
      const displayName = String(row.display_name || botMeta?.title || row.name || '')
      return {
        name: String(row.name ?? ''),
        displayName,
        isDefault: Boolean(row.is_default),
        model: String(row.model ?? ''),
        description: String(row.description ?? ''),
        color: botMeta?.color == null ? undefined : String(botMeta.color),
        canonicalSessionId: row.canonical_session?.id ? String(row.canonical_session.id) : undefined,
      }
    })
    return { profiles, botModeProtocol: Boolean(raw.bot_mode_protocol) }
  }

  /** 打开某个 Bot：连它自己的 gateway → 找 canonical 会话 → 没有就新建一条 → 恢复历史。
   *  没聊过的 Bot 也必须能点开，这是与官方 Bot 模式对齐的行为。 */
  async openBot(request: { profile: string }): Promise<ResumeResult> {
    const profile = String(request?.profile ?? '').trim() || this.defaultProfile
    const transport = this.transportFor(profile)
    await this.ensureOnline(transport)
    const sessionId = await this.resolveCanonicalSession(transport, profile)
    return this.resumeOn(transport, sessionId)
  }

  /** 该 profile 的 gateway 只认自己的 DB，所以这条查询必须在它自己的连接上跑。 */
  private async readCanonicalId(transport: GatewayTransport, profile: string): Promise<string | undefined> {
    const raw = await transport.rpc<{ profiles?: RpcProfileRow[] }>(
      'profiles.list', { include_sessions: true },
    )
    const rows = raw.profiles ?? []
    const row = rows.find(item => String(item.name ?? '') === profile) ?? rows[0]
    const id = row?.canonical_session?.id
    return id == null || id === '' ? undefined : String(id)
  }

  private async resolveCanonicalSession(transport: GatewayTransport, profile: string): Promise<string> {
    const existing = await this.readCanonicalId(transport, profile)
    if (existing) return existing
    try {
      const created = await transport.rpc<{ session_id?: unknown }>('session.create', {
        profile,
        title: BOT_CHAT_TITLE,
        source: 'gui',
        follow_profile_config: true,
      })
      const sessionId = created.session_id == null ? '' : String(created.session_id)
      if (!sessionId) throw new Error('Hermes 没有返回新建会话的 id')
      return sessionId
    } catch (error) {
      // title 有唯一约束：别的窗口刚好抢先建了同一条 Bot Chat，重读一次即可。
      const retried = await this.readCanonicalId(transport, profile)
      if (retried) return retried
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  async resumeSession(request: { sessionId: string; profile?: string }): Promise<ResumeResult> {
    const sessionId = String(request?.sessionId ?? '').trim()
    if (!sessionId) throw new Error('缺少 sessionId')
    const transport = this.transportFor(request?.profile)
    await this.ensureOnline(transport)
    return this.resumeOn(transport, sessionId)
  }

  private async resumeOn(transport: GatewayTransport, sessionId: string): Promise<ResumeResult> {
    const raw = await transport.rpc<RpcResumeResult>('session.resume', {
      session_id: sessionId,
      defer_history: true,
    })
    const messages: ChatMessage[] = (raw.messages ?? []).map((row, index) => ({
      id: String(row.message_uid ?? row.row_id ?? index),
      role: String(row.role ?? 'unknown'),
      text: extractText(row.content),
      toolName: row.tool_name == null || row.tool_name === '' ? undefined : String(row.tool_name),
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
  async submitPrompt(request: { sessionId: string; text: string; profile?: string }): Promise<PromptResult> {
    const sessionId = String(request?.sessionId ?? '').trim()
    const text = String(request?.text ?? '').trim()
    if (!sessionId || !text) return { accepted: false, errorMessage: '会话或消息为空' }
    try {
      const transport = this.transportFor(request?.profile)
      await this.ensureOnline(transport)
      await transport.rpc('prompt.submit', {
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
  async interruptSession(
    request: { sessionId: string; executionGeneration?: number; profile?: string },
  ): Promise<InterruptResult> {
    const sessionId = String(request?.sessionId ?? '').trim()
    if (!sessionId) return { accepted: false, errorMessage: '缺少 sessionId' }
    if (typeof request?.executionGeneration !== 'number') {
      return { accepted: false, errorMessage: '缺少执行代次，请先恢复会话' }
    }
    try {
      const transport = this.transportFor(request?.profile)
      await this.ensureOnline(transport)
      await transport.rpc('session.interrupt', {
        session_id: sessionId,
        execution_generation: request.executionGeneration,
      })
      return { accepted: true }
    } catch (error) {
      return { accepted: false, errorMessage: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 事件按连接隔离，必须读当前 Bot 那条，否则会把别的 profile 的事件混进来。 */
  async getEvents(request?: { profile?: string }): Promise<EventsPage> {
    const events = this.transportFor(request?.profile).drainEvents()
    return { events: events.filter(event => STREAM_EVENT_TYPES.has(String(event.type))) }
  }
}

const prototype = HermesBridgeService.prototype as unknown as Record<string, (...args: never[]) => Promise<unknown>>
for (const name of [
  'ping',
  'getConnectionStatus',
  'getBotRoster',
  'openBot',
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
