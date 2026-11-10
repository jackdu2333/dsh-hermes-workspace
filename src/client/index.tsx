import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { PACKAGE_NAME, PANEL_ID, REMOTE_NAMESPACE } from '../shared/constants'
import type {
  BotProfile,
  BotRoster,
  ChatMessage,
  EventsPage,
  GatewayEvent,
  GatewayStatus,
  InterruptResult,
  PromptResult,
  ResumeResult,
} from '../shared/dto'

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

type HermesRemote = {
  getConnectionStatus: (request?: { profile?: string }) => Promise<RemoteResult<GatewayStatus>>
  getBotRoster: () => Promise<RemoteResult<BotRoster>>
  openBot: (request: { profile: string }) => Promise<RemoteResult<ResumeResult>>
  resumeSession: (request: { sessionId: string; profile?: string }) => Promise<RemoteResult<ResumeResult>>
  submitPrompt: (request: { sessionId: string; text: string; profile?: string }) => Promise<RemoteResult<PromptResult>>
  interruptSession: (request: {
    sessionId: string
    executionGeneration?: number
    profile?: string
  }) => Promise<RemoteResult<InterruptResult>>
  getEvents: (request?: { profile?: string }) => Promise<RemoteResult<EventsPage>>
}

type SlotCtx = {
  logger?: { error?: (...args: unknown[]) => void }
  inject: (deps: string[], callback: (child: SlotCtx) => void) => void
  remote: {
    $mount: (contribution: unknown) => Promise<unknown>
    hermesWorkspace?: HermesRemote
  }
  slots: {
    inject: (name: string, register: () => unknown) => unknown
    register: (meta: Record<string, unknown>, component: (props: any) => ReactElement) => unknown
  }
}

/** Client 侧 contribution 必须复刻官方 `createTypertRemoteInfo` 的产出形状：
 *  descriptor 带 strict codec 与 input/invoke 能力，contribution 额外暴露 methods 映射。
 *  宿主 `$mount` 按 generated Remote 的形状校验，缺字段会在挂载期直接抛错。
 *  passthrough schema 避免引入浏览器侧不存在的 zod。 */
/** 带参数的 RPC 必须在 contribution 里逐个声明：宿主按这里的 parameters 解析入参，
 *  漏掉一个就会以「参数为空」调用，表现为 profile 丢失、连回 default。 */
const METHOD_PARAMETERS: Record<string, string[]> = {
  getConnectionStatus: ['request'],
  openBot: ['request'],
  resumeSession: ['request'],
  submitPrompt: ['request'],
  interruptSession: ['request'],
  getEvents: ['request'],
}

const METHOD_NAMES = [
  'ping',
  'getConnectionStatus',
  'getBotRoster',
  'openBot',
  'resumeSession',
  'submitPrompt',
  'interruptSession',
  'getEvents',
] as const

function buildContribution() {
  const methods: Record<string, unknown> = Object.create(null)
  const descriptors = METHOD_NAMES.map(method => {
    const passthrough = () => ({ parse: (value: unknown) => value })
    const descriptor = {
      id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}`,
      service: REMOTE_NAMESPACE,
      namespace: REMOTE_NAMESPACE,
      method,
      invocation: { kind: 'direct' as const },
      parameters: (METHOD_PARAMETERS[method] ?? []).map(name => ({
        name,
        wire: name,
        source: 'json' as const,
        codec: {
          mode: 'strict' as const,
          // 宿主的 validateCodec 要求 strict codec 带非空 type symbol，缺失会抛 reading 'length'。
          typeSymbol: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}:${name}`,
          create: passthrough,
          jsonSchema: {},
        },
      })),
      result: {
        mode: 'strict' as const,
        typeSymbol: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}:result`,
        create: passthrough,
        jsonSchema: {},
      },
      // 宿主用它判断 descriptor 是否为可直接调用的 generated method。
      input: passthrough,
      invoke: () => {
        throw new Error('hermes-workspace: 该方法的入参由宿主侧解析，Client 不直接 invoke')
      },
    }
    methods[`${REMOTE_NAMESPACE}/${method}`] = descriptor
    return descriptor
  })
  return { package: PACKAGE_NAME, descriptors, methods }
}

const TYPERT_REMOTE = buildContribution()

const inject = ['slots', 'layout', 'remote']

/** 把堆栈首帧压成一行，供面板内定位挂载失败的具体位置。 */
function describeFrame(error: Error): string {
  const frame = error.stack?.split('\n').find(line => line.trim().startsWith('at '))
  return frame ? ` @ ${frame.trim().slice(0, 180)}` : ''
}

/** 面板注册必须与 Remote 挂载解耦：$mount 失败时仍要注册侧边栏入口和面板，
 *  否则界面上没有任何可点入口，连失败原因都看不到。挂载错误改为面板内可见的诊断信息。
 *  同时不能 rethrow：DSH Web boot 只要有 entry 未激活就整体失败。 */
async function apply(ctx: SlotCtx) {
  let mountError: string | null = null
  try {
    await ctx.remote.$mount(TYPERT_REMOTE)
  } catch (error) {
    mountError = error instanceof Error ? `${error.message}${describeFrame(error)}` : String(error)
    ctx.logger?.error?.('hermes-workspace: remote mount failed: %o', error)
  }
  const holder: RemoteHolder = {}
  try {
    ctx.inject(['remote.hermesWorkspace'], child => {
      holder.current = child.remote.hermesWorkspace
    })
  } catch (error) {
    ctx.logger?.error?.('hermes-workspace: remote namespace binding failed: %o', error)
  }
  try {
    registerWorkspace(ctx, mountError, holder)
  } catch (error) {
    ctx.logger?.error?.('hermes-workspace: panel registration failed: %o', error)
  }
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw result.error
}

/** 每次调用时再取 Remote 服务：挂载可能晚于面板注册，不能用注册时的快照。 */
function createApi(getRemote: () => HermesRemote | undefined): PanelApi {
  async function call<T>(method: keyof HermesRemote, ...args: unknown[]): Promise<T> {
    const remote = getRemote()
    const invoke = remote?.[method] as ((...params: unknown[]) => Promise<RemoteResult<T>>) | undefined
    if (typeof invoke !== 'function') throw new Error(`Hermes 服务尚未就绪（${method}）`)
    return unwrap(await invoke(...args))
  }
  return {
    getConnectionStatus: request => call<GatewayStatus>('getConnectionStatus', request),
    getBotRoster: () => call<BotRoster>('getBotRoster'),
    openBot: request => call<ResumeResult>('openBot', request),
    resumeSession: request => call<ResumeResult>('resumeSession', request),
    submitPrompt: request => call<PromptResult>('submitPrompt', request),
    interruptSession: request => call<InterruptResult>('interruptSession', request),
    getEvents: request => call<EventsPage>('getEvents', request),
  }
}

/** Cordis 只允许访问 inject 声明过的服务，因此在服务就绪时把 Remote 绑定进 holder；
 *  面板注册不等它就绪，避免挂载失败连带丢掉入口。 */
type RemoteHolder = { current?: HermesRemote }

function registerWorkspace(ctx: SlotCtx, mountError: string | null, holder: RemoteHolder) {
  const api = createApi(() => holder.current)
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID, inject: () => ({ api, mountError }) },
      HermesChatPanel,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 18, label: () => 'Hermes' },
      HermesIcon,
    ),
  )
}

function HermesIcon(props: { size?: number; active?: boolean }) {
  const size = props.size ?? 20
  const color = props.active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)'
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <path fill={color} d="M12 2.5c.4 0 .7.2.9.5l1.8 3.1 3.5.6c.8.1 1.1 1.1.5 1.7l-2.6 2.6.6 3.6c.1.8-.7 1.4-1.4 1L12 14.4l-3.3 1.7c-.7.4-1.5-.2-1.4-1l.6-3.6L5.3 8.4c-.6-.6-.3-1.6.5-1.7l3.5-.6L11.1 3c.2-.3.5-.5.9-.5Z" />
    </svg>
  )
}

/** 折叠行左侧的小标识：四角星，暗示「这是模型的思考动作」。 */
function SparkIcon({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" style={{ display: 'block' }}>
      <path
        fill="currentColor"
        d="M8 1.4c.28 0 .53.18.62.45l.92 2.85a2.4 2.4 0 0 0 1.53 1.53l2.85.92a.66.66 0 0 1 0 1.25l-2.85.92a2.4 2.4 0 0 0-1.53 1.53l-.92 2.85a.66.66 0 0 1-1.25 0l-.92-2.85a2.4 2.4 0 0 0-1.53-1.53l-2.85-.92a.66.66 0 0 1 0-1.25l2.85-.92A2.4 2.4 0 0 0 6.45 4.7l.92-2.85A.66.66 0 0 1 8 1.4Z"
      />
    </svg>
  )
}

function ChevronIcon({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 12 12" width={size} height={size} aria-hidden="true" style={{ display: 'block' }}>
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TerminalIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" style={{ display: 'block' }}>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.4 6.2 6.3 8l-1.9 1.8M8.2 10h3.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 把 Bot 配的主色稀释成头像底色。只接受简单颜色字面量，避免把外部字符串直接塞进 CSS。 */
function tint(color: string | undefined, percent: number): string | undefined {
  if (!color) return undefined
  if (!/^[#a-zA-Z0-9(),.%\s-]+$/.test(color)) return undefined
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`
}

type PanelApi = {
  getConnectionStatus: (request?: { profile?: string }) => Promise<GatewayStatus>
  getBotRoster: () => Promise<BotRoster>
  openBot: (request: { profile: string }) => Promise<ResumeResult>
  resumeSession: (request: { sessionId: string; profile?: string }) => Promise<ResumeResult>
  submitPrompt: (request: { sessionId: string; text: string; profile?: string }) => Promise<PromptResult>
  interruptSession: (request: {
    sessionId: string
    executionGeneration?: number
    profile?: string
  }) => Promise<InterruptResult>
  getEvents: (request?: { profile?: string }) => Promise<EventsPage>
}

function stateLabel(state: GatewayStatus['state']): string {
  if (state === 'online') return '已连接'
  if (state === 'connecting') return '连接中'
  if (state === 'error') return '连接失败'
  return '未连接'
}

function HermesChatPanel(props: { api?: PanelApi; mountError?: string | null }) {
  const api = props.api
  const mountError = props.mountError ?? null
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [profiles, setProfiles] = useState<BotProfile[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [events, setEvents] = useState<GatewayEvent[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** chat：本插件的气泡对话（默认）；terminal：内嵌 Hermes 终端 TUI。
   *  注意：Hermes 桌面端那个带 BOTS 侧栏的气泡界面是 Electron 专属渲染层
   *  （依赖 window.hermesDesktop 预加载桥），iframe 无法承载，所以这里不提供。 */
  const [view, setView] = useState<'terminal' | 'chat'>('chat')
  /** 当前 Bot 的 profile 名。Hermes 每个 profile 是独立 gateway，所有 RPC 都要带上它。 */
  const [activeProfile, setActiveProfile] = useState<string | null>(null)
  /** 正在握手/建会话的 Bot，列表里用它显示「连接中」。 */
  const [pendingProfile, setPendingProfile] = useState<string | null>(null)
  const sessionRef = useRef<string | null>(null)
  const profileRef = useRef<string | null>(null)
  const generationRef = useRef<number | undefined>(undefined)
  const lastRefreshRef = useRef(0)
  const previousState = useRef<GatewayStatus['state']>('disconnected')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  /** 只有视口贴底时才跟随新消息；用户往上翻历史时不再强行拽回底部。 */
  const stickToBottom = useRef(true)

  /** resume 同时提供历史与执行代次；后者是 interrupt / steer 的必需参数。 */
  function applyResume(resumed: ResumeResult, profile: string): void {
    sessionRef.current = resumed.sessionId
    profileRef.current = profile
    generationRef.current = resumed.executionGeneration
    setActiveProfile(profile)
    setSessionId(resumed.sessionId)
    setMessages(resumed.messages)
  }

  /** 刷新历史 / 事件都要落在当前 Bot 自己那条连接上。 */
  function currentProfile(): string | undefined {
    return profileRef.current ?? undefined
  }

  async function refreshHistory(): Promise<void> {
    if (!api || !sessionRef.current) return
    try {
      applyResume(
        await api.resumeSession({ sessionId: sessionRef.current, profile: currentProfile() }),
        profileRef.current ?? '',
      )
    } catch {
      // 轮询刷新失败时保留上一次历史，不打断界面
    }
  }

  async function loadRoster(): Promise<void> {
    if (!api) return
    const roster = await api.getBotRoster()
    setProfiles(roster.profiles)
    if (profileRef.current !== null) return
    // 默认打开 default Bot；它没有会话时 openBot 会自动建一条，不会卡在空白。
    const preferred = roster.profiles.find(row => row.isDefault) ?? roster.profiles[0]
    if (preferred) await openBot(preferred)
  }

  /** 打开 Bot：主机侧会连上该 profile 自己的 gateway、找（或建）canonical 会话再返回历史。
   *  所以列表项不能再按「有没有 sessionId」置灰——那个字段在别的 profile 上本来就读不到。 */
  async function openBot(row: BotProfile): Promise<void> {
    if (!api) return
    setBusy(true)
    setPendingProfile(row.name)
    setError(null)
    try {
      applyResume(await api.openBot({ profile: row.name }), row.name)
      stickToBottom.current = true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      setPendingProfile(null)
    }
  }

  async function send(): Promise<void> {
    if (!api || !sessionId || !draft.trim()) return
    setBusy(true)
    setError(null)
    stickToBottom.current = true
    try {
      const result = await api.submitPrompt({ sessionId, text: draft.trim(), profile: currentProfile() })
      if (!result.accepted) setError(result.errorMessage ?? '消息未被接受')
      else {
        setDraft('')
        // prompt.submit 是 fire-and-forget，回复由事件通知；延迟拉一次历史把新消息显示出来。
        window.setTimeout(() => void refreshHistory(), 1800)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  /** 重发：把某条用户消息原样再提交一次（不覆盖输入框）。 */
  async function resend(text: string): Promise<void> {
    if (!api || !sessionId || !text.trim()) return
    setBusy(true)
    setError(null)
    stickToBottom.current = true
    try {
      const result = await api.submitPrompt({ sessionId, text: text.trim(), profile: currentProfile() })
      if (!result.accepted) setError(result.errorMessage ?? '重发失败')
      else window.setTimeout(() => void refreshHistory(), 1800)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function interrupt(): Promise<void> {
    if (!api || !sessionId) return
    setBusy(true)
    try {
      const result = await api.interruptSession({
        sessionId,
        executionGeneration: generationRef.current,
        profile: currentProfile(),
      })
      if (!result.accepted) setError(result.errorMessage ?? '中断失败')
      else window.setTimeout(() => void refreshHistory(), 800)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!api) return
    let cancelled = false
    void (async () => {
      try {
        await loadRoster()
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await api.getConnectionStatus({ profile: currentProfile() })
          if (cancelled) return
          setStatus(next)
          const recovered = previousState.current !== 'online' && next.state === 'online'
          previousState.current = next.state
          if (recovered && sessionRef.current) {
            const resumed = await api.resumeSession({
              sessionId: sessionRef.current,
              profile: currentProfile(),
            })
            if (!cancelled) applyResume(resumed, profileRef.current ?? '')
          }
          const page = await api.getEvents({ profile: currentProfile() })
          if (!cancelled && page.events.length) {
            setEvents(previous => [...previous, ...page.events].slice(-12))
            // 收到对话/工具/turn 事件时刷新历史，让 DSH 与 Desktop 看到同一条消息。
            const hasChatEvent = page.events.some(item => /message|turn|prompt|tool|assistant|complete/i.test(String(item.type)))
            if (hasChatEvent && sessionRef.current && Date.now() - lastRefreshRef.current > 2500) {
              lastRefreshRef.current = Date.now()
              const resumed = await api.resumeSession({
                sessionId: sessionRef.current,
                profile: currentProfile(),
              })
              if (!cancelled) applyResume(resumed, profileRef.current ?? '')
            }
          }
        } catch {
          // 轮询失败时保留上一次状态，不打断界面
        }
      })()
    }, 1500)
    return () => { cancelled = true; clearInterval(timer) }
  }, [api])

  // 新消息到达后贴住底部，和原生聊天一致；用户主动上翻时不打扰。
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages.length, sessionId, busy])

  // 输入框随内容自动增高，最多长到 132px 再内部滚动。
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
  }, [draft])

  const state = status?.state ?? 'disconnected'
  const active = profiles.find(row => row.name === activeProfile) ?? null
  const canSend = Boolean(sessionId) && !busy && Boolean(draft.trim())
  /** 原生界面走 Host 的本地反代（已注入 dashboard token），不能直连 gateway 端口。 */
  const nativeOrigin = status?.dashboardOrigin
  /** `/bots` 只是导航壳子、没有对应页面组件（主区会全黑）。
   *  Dashboard 里真正的对话页是 `/chat?resume=<sessionId>`；未选 Bot 时退回会话列表。 */
  const nativeSrc = nativeOrigin
    ? sessionId
      ? `${nativeOrigin}/chat?resume=${encodeURIComponent(sessionId)}`
      : `${nativeOrigin}/sessions`
    : null
  const headerInitial = active ? (active.displayName || active.name).slice(0, 1).toUpperCase() : 'H'

  /** 把连续的工具消息聚成一组，渲染成紧凑的胶囊簇（参考 AI 原生界面的 tool chips）。 */
  const blocks: Array<{ key: string; message?: ChatMessage; tools?: ChatMessage[] }> = []
  for (const message of messages) {
    // 空的助手回合是「只发了工具调用」的占位，必须在分组前跳过，
    // 否则它会把连续的工具消息切成一段段，胶囊又变回一列长表。
    if (message.role === 'assistant' && !message.text.trim()) continue
    if (message.role === 'tool') {
      const last = blocks[blocks.length - 1]
      if (last?.tools) last.tools.push(message)
      else blocks.push({ key: `tool-${message.id}`, tools: [message] })
    } else {
      blocks.push({ key: message.id, message })
    }
  }

  return (
    <div style={pageStyle}>
      <style>{PANEL_CSS}</style>
      <aside style={sidebarStyle} className="hw-scroll">
        <div style={sidebarTitleStyle}>机器人</div>
        <div style={botListStyle}>
          {profiles.length === 0 ? <div style={sidebarEmptyStyle}>尚未读取到 Bot</div> : null}
          {profiles.map(row => {
            const selected = row.name === activeProfile
            const opening = pendingProfile === row.name
            return (
              <button
                key={row.name}
                type="button"
                className="hw-bot"
                disabled={busy}
                onClick={() => void openBot(row)}
                title={opening ? '正在连接 Hermes…' : `打开 ${row.displayName || row.name}`}
                style={{
                  ...botItemStyle,
                  ...(selected ? botItemActiveStyle : {}),
                }}
              >
                {selected ? <span style={botActiveBarStyle} /> : null}
                <span
                  style={{
                    ...avatarStyle,
                    ...(selected ? avatarActiveStyle : {}),
                    ...(row.color ? { background: tint(row.color, 18) } : {}),
                  }}
                >
                  {(row.displayName || row.name).slice(0, 1).toUpperCase()}
                </span>
                <span style={botTextStyle}>
                  <span style={botNameStyle}>{row.displayName || row.name}</span>
                  <span style={botPreviewStyle}>
                    {opening ? '正在连接…' : (row.description || row.model || '可继续对话')}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </aside>

      <section style={chatPaneStyle}>
        <div style={chatHeaderStyle}>
          <span style={{ ...headerAvatarStyle, ...(active?.color ? { background: tint(active.color, 16) } : {}) }}>
            {headerInitial}
          </span>
          <span style={chatTitleStyle}>{active ? (active.displayName || active.name) : 'Bot 对话'}</span>
          {active?.model ? <span style={modelChipStyle}>{active.model}</span> : null}
          <span style={{ flex: 1 }} />
          <span style={statusWrapStyle} title={status?.errorMessage ?? stateLabel(state)}>
            <span style={{ ...dotStyle, ...(state === 'online' ? dotOkStyle : dotWarnStyle) }} />
            {stateLabel(state)}
          </span>
          <span style={headerDividerStyle} />
          <button
            type="button"
            className="hw-ghost"
            onClick={() => setView(view === 'terminal' ? 'chat' : 'terminal')}
            style={ghostButtonStyle}
            title={
              view === 'terminal'
                ? '切回插件内的气泡对话'
                : '切到 Hermes 终端界面（可直接在里面输入）'
            }
          >
            <TerminalIcon />
            {view === 'terminal' ? '对话' : '终端'}
          </button>
          {view === 'chat' && sessionId ? (
            <button
              type="button"
              className="hw-ghost hw-stop"
              disabled={busy}
              onClick={() => void interrupt()}
              style={ghostButtonStyle}
              title="中断当前执行"
            >
              中断
            </button>
          ) : null}
        </div>

        {view === 'terminal' && nativeSrc ? (
          <>
            <div style={terminalHintStyle}>
              Hermes 终端界面：点一下黑色区域即可输入，回车发送，Ctrl+C 中断。
            </div>
            <iframe
              key={nativeSrc}
              title="Hermes 终端（TUI）"
              src={nativeSrc}
              style={iframeStyle}
            />
          </>
        ) : null}

        {view === 'terminal' && !nativeOrigin ? (
          <div style={emptyStyle}>
            {state === 'online' ? '正在启动终端代理…' : '正在连接本机 Hermes…'}
          </div>
        ) : null}

        {view === 'chat' ? (
          <>
            {mountError ? <p style={errorStyle}>Remote 挂载失败：{mountError}</p> : null}
            {status?.errorMessage ? <p style={errorStyle}>{status.errorMessage}</p> : null}
            {error ? <p style={errorStyle}>{error}</p> : null}

            <div
              style={messagesStyle}
              className="hw-scroll"
              ref={scrollRef}
              onScroll={() => {
                const el = scrollRef.current
                if (!el) return
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
              }}
            >
              {messages.length === 0 ? (
                <div style={emptyWrapStyle}>
                  <span style={emptyIconStyle}><HermesIcon size={18} /></span>
                  <div style={emptyTitleStyle}>{sessionId ? '还没有消息' : '选一个 Bot 开始'}</div>
                  <div style={emptyHintStyle}>
                    {sessionId ? '在下面输入框里说点什么，Hermes 会在这里回复。' : '左侧列表里选择一个 Bot，历史对话会在这里展开。'}
                  </div>
                </div>
              ) : null}
              {blocks.map(block =>
                block.tools ? (
                  <ToolGroup key={block.key} items={block.tools} />
                ) : block.message ? (
                  <MessageRow
                    key={block.key}
                    message={block.message}
                    canResend={!busy && Boolean(sessionId)}
                    onResend={text => void resend(text)}
                  />
                ) : null,
              )}
              {busy ? (
                <div style={typingRowStyle}>
                  <span className="hw-typing" style={typingDotsStyle}><span /><span /><span /></span>
                  <span style={typingTextStyle}>Hermes 正在处理</span>
                </div>
              ) : null}
            </div>

            <div style={composerStyle} className="hw-composer">
              <textarea
                ref={textareaRef}
                rows={1}
                value={draft}
                placeholder={sessionId ? '发消息给 Hermes…' : '先选择一个 Bot'}
                disabled={!sessionId || busy}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                  // 中文输入法组词时的回车是选中候选词，不能当发送。
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    void send()
                  }
                }}
                style={textareaStyle}
              />
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void send()}
                title="发送（Enter）"
                style={{ ...sendButtonStyle, ...(canSend ? sendButtonReadyStyle : buttonDisabledStyle) }}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5M6 11l6-6 6 6" />
                </svg>
              </button>
            </div>
            <div style={composerHintStyle}>Enter 发送 · Shift + Enter 换行</div>
          </>
        ) : null}
      </section>
    </div>
  )
}

/** 原生聊天流：用户消息是浅灰左气泡、助手是裸文本、工具调用折叠成一行。
 *  每条消息带轻量操作：复制；用户消息额外支持「重发」。 */
function MessageRow({
  message,
  onResend,
  canResend,
}: {
  message: ChatMessage
  onResend?: (text: string) => void
  canResend?: boolean
}) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    const text = message.text || ''
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      },
      () => undefined,
    )
  }

  // 纯工具调用的助手回合 content 为空，不该在气泡流里显示成一行。
  if (message.role === 'assistant' && !message.text.trim()) return null

  const isUser = message.role === 'user'
  return (
    <div
      className="hw-row"
      style={isUser ? userRowStyle : assistantRowStyle}
      data-copied={copied ? 'true' : 'false'}
    >
      <div style={isUser ? userStackStyle : assistantStackStyle}>
        <div style={isUser ? userBubbleStyle : assistantTextStyle} className={isUser ? undefined : 'hw-md'}>
          {isUser ? (message.text || '（空消息）') : <MarkdownBlock text={message.text || '（空消息）'} />}
        </div>
        <div className="hw-action" style={isUser ? userActionRowStyle : assistantActionRowStyle}>
          <button type="button" onClick={copy} style={actionButtonStyle}>
            {copied ? '已复制' : '复制'}
          </button>
          {isUser && canResend && message.text ? (
            <button type="button" onClick={() => onResend?.(message.text)} style={actionButtonStyle}>
              重发
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 一段「中间过程」压成一行摘要，点开才展开成步骤列表。
 *  折叠态是一枚有边框的胶囊（可点、有 hover），展开后按序号竖排，层级比横排胶囊清楚。 */
function ToolGroup({ items }: { items: ChatMessage[] }) {
  const [open, setOpen] = useState(false)
  const details = items.map(item => ({ id: item.id, ...toolDetail(item.text, item.toolName) }))
  const single = details.length === 1 ? details[0] : null
  // 兜底名没有信息量，出现在摘要行里只会变成噪声（9 个步骤 · 工具调用）。
  const names = [...new Set(details.map(item => item.name))]
    .filter(name => name !== FALLBACK_TOOL_NAME)
    .slice(0, 3)
  const label = single
    ? single.name === FALLBACK_TOOL_NAME ? '1 个步骤' : single.name
    : `${items.length} 个步骤`
  const failed = details.some(item => !item.ok)
  return (
    <div style={toolGroupStyle}>
      <button
        type="button"
        className="hw-tool-toggle"
        onClick={() => setOpen(value => !value)}
        style={toolToggleStyle}
        title={open ? '收起中间步骤' : '展开中间步骤'}
      >
        <span style={{ ...toolGlyphStyle, ...(failed ? toolGlyphFailStyle : {}) }}>
          {failed ? '!' : <SparkIcon />}
        </span>
        <span style={toolLabelStyle}>{label}</span>
        <span style={toolMetaStyle}>{single ? single.summary : names.join(' · ')}</span>
        <span style={{ ...toolChevronStyle, transform: open ? 'rotate(90deg)' : 'none' }}>
          <ChevronIcon />
        </span>
      </button>
      {open ? (
        single ? (
          <pre style={toolPreStyle}>{single.pretty}</pre>
        ) : (
          <div style={toolStepsStyle}>
            {details.map((item, index) => (
              <ToolStep key={item.id} index={index} detail={item} />
            ))}
          </div>
        )
      ) : null}
    </div>
  )
}

/** 单个步骤：序号 + 工具名 + 结果摘要，点开看原始 JSON。 */
function ToolStep({
  index,
  detail,
}: {
  index: number
  detail: { name: string; summary: string; pretty: string; ok: boolean }
}) {
  const [open, setOpen] = useState(false)
  return (
    <div style={toolStepWrapStyle}>
      <button type="button" className="hw-step" onClick={() => setOpen(value => !value)} style={toolStepButtonStyle}>
        <span style={toolStepIndexStyle}>{String(index + 1).padStart(2, '0')}</span>
        <span style={toolNameStyle}>{detail.name}</span>
        <span style={toolSummaryStyle}>{detail.summary}</span>
        <span style={{ ...toolDotStyle, ...(detail.ok ? {} : toolDotFailStyle) }} />
      </button>
      {open ? <pre style={toolPreStyle}>{detail.pretty}</pre> : null}
    </div>
  )
}

/** 工具名兜底值：宿主未透传 tool_name、JSON 里也没有可用字段时的占位。 */
const FALLBACK_TOOL_NAME = '工具调用'

/** 工具消息通常是 JSON；抽出名字、状态与一句话摘要，原始载荷留给展开。 */
function toolDetail(text: string, toolName?: string): { name: string; summary: string; pretty: string; ok: boolean } {
  let parsed: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>
  } catch {
    parsed = null
  }
  if (!parsed) {
    return {
      name: toolName || FALLBACK_TOOL_NAME,
      summary: text.replace(/\s+/g, ' ').slice(0, 60),
      pretty: text,
      ok: true,
    }
  }
  const name = toolName || String(parsed.name ?? parsed.tool ?? parsed.tool_name ?? parsed.type ?? FALLBACK_TOOL_NAME)
  const failed = Boolean(parsed.error) || parsed.ok === false || parsed.status === 'error'
  // 摘要优先取结果里的 message / output 首句，其次才是 action 或参数键名。
  const rawSummary =
    parsed.message ??
    parsed.summary ??
    parsed.action ??
    (typeof parsed.output === 'string' ? parsed.output.split('\n')[0] : undefined) ??
    parsed.arguments ??
    parsed.args
  const summary = typeof rawSummary === 'string'
    ? rawSummary.replace(/\s+/g, ' ').slice(0, 70)
    : rawSummary && typeof rawSummary === 'object'
      ? Object.keys(rawSummary as Record<string, unknown>).slice(0, 4).join(' · ')
      : ''
  let pretty = text
  try {
    pretty = JSON.stringify(parsed, null, 2)
  } catch {
    pretty = text
  }
  return { name, summary, pretty, ok: !failed }
}

/** 行内标记：**粗体** 与 `代码`。 */
function inlineParts(text: string): (string | ReactElement)[] {
  const parts: (string | ReactElement)[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let cursor = 0
  let key = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    const token = match[0]
    if (token.startsWith('**')) {
      parts.push(<strong key={key++} style={mdStrongStyle}>{token.slice(2, -2)}</strong>)
    } else {
      parts.push(<code key={key++} style={mdCodeStyle}>{token.slice(1, -1)}</code>)
    }
    cursor = match.index + token.length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

/** 轻量 Markdown：标题 / 列表 / 代码块 / 段落，足够还原 Hermes Bot 的排版。
 *  不引入依赖，遇到不认识的语法按普通文本处理。 */
function MarkdownBlock({ text }: { text: string }) {
  const nodes: ReactElement[] = []
  let paragraph: string[] = []
  let list: string[] = []
  let listOrdered = false
  let code: string[] | null = null
  let key = 0

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    nodes.push(<p key={key++} style={mdParagraphStyle}>{inlineParts(paragraph.join('\n'))}</p>)
    paragraph = []
  }
  const flushList = () => {
    if (list.length === 0) return
    const items = list.map((item, index) => <li key={index} style={mdListItemStyle}>{inlineParts(item)}</li>)
    nodes.push(
      listOrdered
        ? <ol key={key++} style={mdListStyle}>{items}</ol>
        : <ul key={key++} style={mdListStyle}>{items}</ul>,
    )
    list = []
  }

  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) {
      if (code === null) {
        flushParagraph()
        flushList()
        code = []
      } else {
        nodes.push(<pre key={key++} style={mdPreStyle}>{code.join('\n')}</pre>)
        code = null
      }
      continue
    }
    if (code !== null) {
      code.push(line)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s*(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      nodes.push(<div key={key++} style={mdHeadingStyle}>{inlineParts(heading[2])}</div>)
      continue
    }
    const unordered = /^\s*[-*]\s+(.*)$/.exec(line)
    if (unordered) {
      flushParagraph()
      if (list.length > 0 && listOrdered) flushList()
      listOrdered = false
      list.push(unordered[1])
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      if (list.length > 0 && !listOrdered) flushList()
      listOrdered = true
      list.push(ordered[1])
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  if (code !== null) nodes.push(<pre key={key++} style={mdPreStyle}>{code.join('\n')}</pre>)
  return <>{nodes}</>
}

/** 交互态（hover / 焦点 / 滚动条 / 动画）内联样式表达不了，统一挂一份前缀化样式表。
 *  所有选择器都以 .hw- 开头；即使宿主不加载它，也只是没有 hover 反馈，不影响可用性。 */
const PANEL_CSS = `
.hw-scroll{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent) transparent}
.hw-scroll::-webkit-scrollbar{width:9px;height:9px}
.hw-scroll::-webkit-scrollbar-track{background:transparent}
.hw-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);border-radius:999px;border:3px solid transparent;background-clip:content-box}
.hw-scroll::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 28%,transparent);background-clip:content-box}
.hw-bot{transition:background .12s ease}
.hw-bot:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.hw-ghost{transition:color .12s ease,background .12s ease}
.hw-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.hw-stop:hover:not(:disabled){color:var(--dsw-alias-label-danger,#c0392b);background:color-mix(in srgb,var(--dsw-alias-label-danger,#c0392b) 10%,transparent)}
.hw-tool-toggle{transition:background .12s ease,border-color .12s ease}
.hw-tool-toggle:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.hw-step{transition:background .12s ease}
.hw-step:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}
.hw-composer{transition:border-color .16s ease,background .16s ease}
.hw-composer:focus-within{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.hw-composer textarea::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-primary) 34%,transparent)}
.hw-md>*:last-child{margin-bottom:0!important}
.hw-action{opacity:0;transition:opacity .12s ease}
.hw-row:hover .hw-action,.hw-row[data-copied='true'] .hw-action{opacity:1}
.hw-typing span{display:inline-block;width:4px;height:4px;border-radius:999px;background:currentColor;margin-right:3px;animation:hw-pulse 1.2s infinite ease-in-out}
.hw-typing span:nth-child(2){animation-delay:.15s}
.hw-typing span:nth-child(3){animation-delay:.3s}
@keyframes hw-pulse{0%,80%,100%{opacity:.22;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}
`

const pageStyle: CSSProperties = {
  display: 'flex', height: '100%', overflow: 'hidden',
  boxSizing: 'border-box', background: 'var(--dsw-alias-bg-primary)', color: 'var(--dsw-alias-label-primary)',
}
const sidebarStyle: CSSProperties = {
  width: 204, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 1,
  padding: '12px 8px', borderRight: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)',
  overflowY: 'auto', boxSizing: 'border-box',
}
const sidebarTitleStyle: CSSProperties = {
  fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
  color: 'var(--dsw-alias-label-secondary)', padding: '6px 10px 10px',
}
const botListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const sidebarEmptyStyle: CSSProperties = { padding: '4px 10px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
const botItemStyle: CSSProperties = {
  position: 'relative', display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 8px',
  border: 'none', borderRadius: 8, background: 'transparent', color: 'inherit',
  textAlign: 'left', cursor: 'pointer', overflow: 'hidden',
}
const botItemActiveStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)',
}
/** 选中态靠左侧 2px 竖条点明，比整块深色更克制。 */
const botActiveBarStyle: CSSProperties = {
  position: 'absolute', left: 0, top: 7, bottom: 7, width: 2, borderRadius: 999,
  background: 'var(--dsw-alias-label-primary)',
}
const avatarStyle: CSSProperties = {
  width: 24, height: 24, borderRadius: 7, flexShrink: 0, display: 'flex',
  alignItems: 'center', justifyContent: 'center',
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)',
  color: 'var(--dsw-alias-label-secondary)', fontSize: 10.5, fontWeight: 600,
}
const avatarActiveStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)',
  color: 'var(--dsw-alias-label-primary)',
}
const botTextStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }
const botNameStyle: CSSProperties = {
  fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const botPreviewStyle: CSSProperties = {
  fontSize: 11, color: 'var(--dsw-alias-label-secondary)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const chatPaneStyle: CSSProperties = {
  flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%',
}
const terminalHintStyle: CSSProperties = {
  flexShrink: 0, padding: '6px 22px 0', fontSize: 11.5,
  color: 'var(--dsw-alias-label-secondary)',
}
const iframeStyle: CSSProperties = {
  flex: 1, width: '100%', border: 'none', minHeight: 0, background: 'transparent',
}
const chatHeaderStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
  padding: '12px 22px',
  borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)',
}
const headerAvatarStyle: CSSProperties = {
  width: 21, height: 21, borderRadius: 6, flexShrink: 0, display: 'flex',
  alignItems: 'center', justifyContent: 'center',
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent)',
  color: 'var(--dsw-alias-label-primary)', fontSize: 10, fontWeight: 600,
}
const chatTitleStyle: CSSProperties = { fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }
/** 模型徽标：等宽小字 + 弱边框，模仿 AI 原生界面里的 model picker（此处只读展示）。 */
const modelChipStyle: CSSProperties = {
  fontSize: 10.5, padding: '1px 7px', borderRadius: 6,
  border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)',
  color: 'var(--dsw-alias-label-secondary)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'nowrap',
}
const dotStyle: CSSProperties = { width: 6, height: 6, borderRadius: 999, flexShrink: 0 }
const dotOkStyle: CSSProperties = { background: 'var(--dsw-alias-label-success, #22a06b)' }
const dotWarnStyle: CSSProperties = { background: 'var(--dsw-alias-label-secondary)' }
/** 连接状态跟绿点绑在一起，和右侧的操作按钮用竖线隔开。 */
const statusWrapStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap',
}
const headerDividerStyle: CSSProperties = {
  width: 1, height: 12, flexShrink: 0,
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)',
}
/** 头部只留文字型按钮，避免一堆描边胶囊把标题区挤满。 */
const ghostButtonStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '3px 7px', borderRadius: 6, border: 'none',
  background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer', fontSize: 11,
}
const errorStyle: CSSProperties = {
  margin: '8px 22px 0', paddingLeft: 8, fontSize: 12,
  color: 'var(--dsw-alias-label-danger, #c0392b)',
  borderLeft: '2px solid var(--dsw-alias-label-danger, #c0392b)',
}
const messagesStyle: CSSProperties = {
  flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column',
  gap: 18, padding: '20px 26px 8px',
}
const userRowStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end' }
const assistantRowStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-start' }
const userStackStyle: CSSProperties = {
  position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: '100%',
}
const assistantStackStyle: CSSProperties = {
  position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', maxWidth: '100%',
}
/** 用户消息气泡：只做轻微着色，绝不反色。
 *  DSH 主题变量在插件上下文里不稳定（曾出现黑底黑字把内容吞掉），
 *  可读性优先：浅色底 + 继承字色，明暗主题都不会翻车。 */
const userBubbleStyle: CSSProperties = {
  maxWidth: 480, padding: '9px 15px', borderRadius: 17,
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)',
  color: 'inherit',
  fontSize: 13.5, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}
const assistantTextStyle: CSSProperties = {
  maxWidth: 680, fontSize: 14, lineHeight: 1.72, wordBreak: 'break-word',
}
const mdParagraphStyle: CSSProperties = {
  margin: '0 0 9px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}
const mdHeadingStyle: CSSProperties = { margin: '16px 0 8px', fontSize: 14.5, fontWeight: 600, lineHeight: 1.5 }
const mdListStyle: CSSProperties = { margin: '0 0 9px', paddingLeft: 20 }
const mdListItemStyle: CSSProperties = { margin: '3px 0', lineHeight: 1.7 }
const mdPreStyle: CSSProperties = {
  margin: '0 0 12px', padding: '10px 12px', borderRadius: 8, overflow: 'auto', maxHeight: 320,
  background: 'var(--dsw-alias-bg-secondary)', color: 'var(--dsw-alias-label-primary)',
  fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}
const mdStrongStyle: CSSProperties = { fontWeight: 600 }
const mdCodeStyle: CSSProperties = {
  padding: '1px 5px', borderRadius: 4, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.92em', background: 'var(--dsw-alias-bg-secondary)',
}
/** 一组工具调用：折叠态是有边框的胶囊行，展开后按序号竖排。
 *  marginTop 收一点，让「步骤」视觉上跟着它后面那条回复走。 */
const toolGroupStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start',
  marginTop: -2, marginBottom: -2, maxWidth: '100%',
}
const toolToggleStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7,
  padding: '4px 9px 4px 8px', borderRadius: 9,
  border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 11%, transparent)',
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 2.5%, transparent)',
  color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
  fontSize: 11.5, lineHeight: 1.45, textAlign: 'left', maxWidth: '100%',
}
const toolGlyphStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 15, height: 15, borderRadius: 4, flexShrink: 0,
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)',
  color: 'var(--dsw-alias-label-secondary)', fontSize: 9.5, fontWeight: 700,
}
const toolGlyphFailStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--dsw-alias-label-danger, #c0392b) 14%, transparent)',
  color: 'var(--dsw-alias-label-danger, #c0392b)',
}
const toolLabelStyle: CSSProperties = { color: 'var(--dsw-alias-label-primary)', fontWeight: 500, flexShrink: 0 }
const toolMetaStyle: CSSProperties = {
  opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320,
}
const toolChevronStyle: CSSProperties = {
  display: 'inline-flex', opacity: 0.55, transition: 'transform .14s ease', flexShrink: 0,
}
const toolStepsStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 1, width: '100%', maxWidth: 560,
  paddingLeft: 6, marginLeft: 6,
  borderLeft: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)',
}
const toolStepWrapStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
/** 步骤行用 grid 对齐：序号 / 工具名 / 摘要 / 状态点四列，名字长短不一时摘要也不参差。 */
const toolStepButtonStyle: CSSProperties = {
  display: 'grid', gridTemplateColumns: '16px minmax(56px, max-content) 1fr 6px',
  alignItems: 'center', columnGap: 8, padding: '3px 6px', width: '100%',
  borderRadius: 6, border: 'none', background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
  fontSize: 11.5, lineHeight: 1.55, textAlign: 'left',
}
const toolStepIndexStyle: CSSProperties = {
  flexShrink: 0, width: 15, fontSize: 9.5, opacity: 0.5,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
/** 工具状态不再用红绿点（彩色噪声大），改成中性小方块，失败时才变红。 */
const toolDotStyle: CSSProperties = {
  width: 4, height: 4, borderRadius: 1.5, flexShrink: 0,
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 35%, transparent)',
}
const toolDotFailStyle: CSSProperties = { background: 'var(--dsw-alias-label-danger, #c0392b)' }
const toolSummaryStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)', opacity: 0.82, minWidth: 0,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
/** 操作条贴在气泡下方 20px 的间隙里，用 Canvas 底色盖住底下的文字，不占布局。 */
const actionButtonStyle: CSSProperties = {
  border: 'none', background: 'transparent', padding: '0 2px', cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', fontSize: 10.5,
}
const userActionRowStyle: CSSProperties = {
  position: 'absolute', right: 2, bottom: -17, display: 'flex', gap: 8,
  padding: '0 4px', borderRadius: 5, background: 'Canvas',
}
const assistantActionRowStyle: CSSProperties = {
  position: 'absolute', left: 2, bottom: -17, display: 'flex', gap: 8,
  padding: '0 4px', borderRadius: 5, background: 'Canvas',
}
const toolNameStyle: CSSProperties = { color: 'var(--dsw-alias-label-primary)', fontWeight: 500, flexShrink: 0 }
const toolPreStyle: CSSProperties = {
  margin: 0, marginLeft: 12, padding: '8px 10px', borderRadius: 8, maxWidth: '86%',
  background: 'var(--dsw-alias-bg-secondary)', color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  maxHeight: 260, overflow: 'auto',
}
const emptyStyle: CSSProperties = { margin: 'auto', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
const emptyWrapStyle: CSSProperties = {
  margin: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
  paddingBottom: 24, maxWidth: 260, textAlign: 'center',
}
const emptyIconStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 34, height: 34, borderRadius: 10, marginBottom: 4,
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)',
  color: 'var(--dsw-alias-label-secondary)',
}
const emptyTitleStyle: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const emptyHintStyle: CSSProperties = {
  fontSize: 11.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)',
}
const typingRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2,
  color: 'var(--dsw-alias-label-secondary)',
}
const typingDotsStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', paddingLeft: 2 }
const typingTextStyle: CSSProperties = { fontSize: 11.5, opacity: 0.8 }
/** 输入区是一个整块圆角盒子：输入区无边框，发送键在盒子内部右下，参考 AI 原生 composer。 */
const composerStyle: CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0,
  margin: '4px 24px 0', padding: '7px 7px 7px 14px',
  borderRadius: 16,
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)',
  border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)',
}
const textareaStyle: CSSProperties = {
  flex: 1, padding: '6px 0', border: 'none', background: 'transparent',
  color: 'inherit', fontSize: 13.5, lineHeight: 1.6, outline: 'none',
  resize: 'none', maxHeight: 132, fontFamily: 'inherit', minHeight: 21,
}
const sendButtonStyle: CSSProperties = {
  width: 30, height: 30, borderRadius: 10, flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)',
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)',
  color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
  transition: 'background .12s ease, color .12s ease, border-color .12s ease',
}
/** 有内容可发时才把发送键提亮；用中性色差而不是主色反白，避免深色主题下白字看不见。 */
const sendButtonReadyStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)',
  borderColor: 'color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent)',
  color: 'var(--dsw-alias-label-primary)',
}
const buttonDisabledStyle: CSSProperties = { opacity: 0.4, cursor: 'default' }
const composerHintStyle: CSSProperties = {
  flexShrink: 0, margin: '6px 30px 14px', textAlign: 'right',
  fontSize: 10, letterSpacing: '0.01em', color: 'var(--dsw-alias-label-secondary)', opacity: 0.45,
}

export { apply, inject, PANEL_ID }
