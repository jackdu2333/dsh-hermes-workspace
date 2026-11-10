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
  getConnectionStatus: () => Promise<RemoteResult<GatewayStatus>>
  getBotRoster: () => Promise<RemoteResult<BotRoster>>
  resumeSession: (request: { sessionId: string }) => Promise<RemoteResult<ResumeResult>>
  submitPrompt: (request: { sessionId: string; text: string }) => Promise<RemoteResult<PromptResult>>
  interruptSession: (request: { sessionId: string; executionGeneration?: number }) => Promise<RemoteResult<InterruptResult>>
  getEvents: () => Promise<RemoteResult<EventsPage>>
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

/** Client 侧 descriptor 必须与 Host 侧 SRC 从方法签名派生的结果一致：
 *  形参名即 wire 名、codec 为 src-json；Host 方法未声明 signal，因此不能带 cancellation
 *  （否则唯一实参会被当成 callerSignal 传给 AbortSignal.any，报转换错误）。 */
function remoteMethod(method: string, parameterNames: string[] = []) {
  return {
    id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' as const },
    parameters: parameterNames.map(name => ({
      name,
      wire: name,
      source: 'json' as const,
      codec: { mode: 'src-json' as const },
    })),
    result: { mode: 'src-json' as const },
  }
}

const TYPERT_REMOTE = {
  package: PACKAGE_NAME,
  descriptors: [
    remoteMethod('getConnectionStatus'),
    remoteMethod('getBotRoster'),
    remoteMethod('resumeSession', ['request']),
    remoteMethod('submitPrompt', ['request']),
    remoteMethod('interruptSession', ['request']),
    remoteMethod('getEvents'),
  ],
}

const inject = ['slots', 'layout', 'remote']

async function apply(ctx: SlotCtx) {
  try {
    await ctx.remote.$mount(TYPERT_REMOTE)
  } catch (error) {
    ctx.logger?.error?.('hermes-workspace: failed to mount Remote namespace: %o', error)
    throw error
  }
  ctx.inject([`remote.${REMOTE_NAMESPACE}`], (child) => registerWorkspace(child))
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw result.error
}

function registerWorkspace(ctx: SlotCtx) {
  const remote = ctx.remote.hermesWorkspace
  const api = {
    getConnectionStatus: async () => {
      if (!remote?.getConnectionStatus) throw new Error('Hermes Workspace 服务尚未就绪')
      return unwrap(await remote.getConnectionStatus())
    },
    getBotRoster: async () => {
      if (!remote?.getBotRoster) throw new Error('Hermes Workspace 服务尚未就绪')
      return unwrap(await remote.getBotRoster())
    },
    resumeSession: async (request: { sessionId: string }) => {
      if (!remote?.resumeSession) throw new Error('Hermes Workspace 服务尚未就绪')
      return unwrap(await remote.resumeSession(request))
    },
    submitPrompt: async (request: { sessionId: string; text: string }) => {
      if (!remote?.submitPrompt) throw new Error('Hermes Workspace 服务尚未就绪')
      return unwrap(await remote.submitPrompt(request))
    },
    interruptSession: async (request: { sessionId: string; executionGeneration?: number }) => {
      if (!remote?.interruptSession) throw new Error('Hermes Workspace 服务尚未就绪')
      return unwrap(await remote.interruptSession(request))
    },
    getEvents: async () => {
      if (!remote?.getEvents) throw new Error('Hermes Workspace 服务尚未就绪')
      return unwrap(await remote.getEvents())
    },
  }
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID, inject: () => ({ api }) },
      HermesChatPanel,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 18, label: 'Hermes' },
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

type PanelApi = {
  getConnectionStatus: () => Promise<GatewayStatus>
  getBotRoster: () => Promise<BotRoster>
  resumeSession: (request: { sessionId: string }) => Promise<ResumeResult>
  submitPrompt: (request: { sessionId: string; text: string }) => Promise<PromptResult>
  interruptSession: (request: { sessionId: string; executionGeneration?: number }) => Promise<InterruptResult>
  getEvents: () => Promise<EventsPage>
}

function stateLabel(state: GatewayStatus['state']): string {
  if (state === 'online') return '已连接'
  if (state === 'connecting') return '连接中'
  if (state === 'error') return '连接失败'
  return '未连接'
}

function HermesChatPanel(props: { api?: PanelApi }) {
  const api = props.api
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [profiles, setProfiles] = useState<BotProfile[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [events, setEvents] = useState<GatewayEvent[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sessionRef = useRef<string | null>(null)
  const generationRef = useRef<number | undefined>(undefined)
  const lastRefreshRef = useRef(0)
  const previousState = useRef<GatewayStatus['state']>('disconnected')

  /** resume 同时提供历史与执行代次；后者是 interrupt / steer 的必需参数。 */
  function applyResume(resumed: ResumeResult): void {
    sessionRef.current = resumed.sessionId
    generationRef.current = resumed.executionGeneration
    setSessionId(resumed.sessionId)
    setMessages(resumed.messages)
  }

  async function refreshHistory(): Promise<void> {
    if (!api || !sessionRef.current) return
    try {
      applyResume(await api.resumeSession({ sessionId: sessionRef.current }))
    } catch {
      // 轮询刷新失败时保留上一次历史，不打断界面
    }
  }

  async function loadRoster(): Promise<void> {
    if (!api) return
    const roster = await api.getBotRoster()
    setProfiles(roster.profiles)
    const preferred = roster.profiles.find(row => row.canonicalSessionId)
    if (preferred?.canonicalSessionId && sessionRef.current === null) {
      applyResume(await api.resumeSession({ sessionId: preferred.canonicalSessionId }))
    }
  }

  async function selectBot(row: BotProfile): Promise<void> {
    if (!api || !row.canonicalSessionId) return
    setBusy(true)
    setError(null)
    try {
      applyResume(await api.resumeSession({ sessionId: row.canonicalSessionId }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function send(): Promise<void> {
    if (!api || !sessionId || !draft.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.submitPrompt({ sessionId, text: draft.trim() })
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

  async function interrupt(): Promise<void> {
    if (!api || !sessionId) return
    setBusy(true)
    try {
      const result = await api.interruptSession({ sessionId, executionGeneration: generationRef.current })
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
          const next = await api.getConnectionStatus()
          if (cancelled) return
          setStatus(next)
          const recovered = previousState.current !== 'online' && next.state === 'online'
          previousState.current = next.state
          if (recovered && sessionRef.current) {
            const resumed = await api.resumeSession({ sessionId: sessionRef.current })
            if (!cancelled) applyResume(resumed)
          }
          const page = await api.getEvents()
          if (!cancelled && page.events.length) {
            setEvents(previous => [...previous, ...page.events].slice(-12))
            // 收到对话/工具/turn 事件时刷新历史，让 DSH 与 Desktop 看到同一条消息。
            const hasChatEvent = page.events.some(item => /message|turn|prompt|tool|assistant|complete/i.test(String(item.type)))
            if (hasChatEvent && sessionRef.current && Date.now() - lastRefreshRef.current > 2500) {
              lastRefreshRef.current = Date.now()
              const resumed = await api.resumeSession({ sessionId: sessionRef.current })
              if (!cancelled) applyResume(resumed)
            }
          }
        } catch {
          // 轮询失败时保留上一次状态，不打断界面
        }
      })()
    }, 1500)
    return () => { cancelled = true; clearInterval(timer) }
  }, [api])

  const state = status?.state ?? 'disconnected'

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <div>
          <div style={kickerStyle}>Hermes · Gateway</div>
          <h1 style={titleStyle}>Bot 对话</h1>
        </div>
        <span style={{ ...badgeStyle, ...(state === 'online' ? badgeOkStyle : badgeWarnStyle) }}>
          {stateLabel(state)}
        </span>
      </div>

      {status?.errorMessage ? <p style={errorStyle}>{status.errorMessage}</p> : null}
      {error ? <p style={errorStyle}>{error}</p> : null}

      <div style={rosterStyle}>
        <div style={sectionLabelStyle}>Bot 列表</div>
        <div style={rowStyle}>
          {profiles.length === 0 ? <span style={mutedStyle}>尚未读取到 Bot，等待 Gateway 连接…</span> : null}
          {profiles.map(row => (
            <button
              key={row.name}
              type="button"
              disabled={busy || !row.canonicalSessionId}
              onClick={() => void selectBot(row)}
              style={{ ...botButtonStyle, ...(row.canonicalSessionId === sessionId ? botActiveStyle : {}) }}
            >
              {row.displayName || row.name}
              <span style={botMetaStyle}>{row.canonicalSessionId ? ' · 可恢复会话' : ' · 无 canonical 会话'}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={chatAreaStyle}>
        <div style={sectionLabelStyle}>
          会话历史{sessionId ? ` · ${sessionId.slice(0, 18)}…` : ''} · {messages.length} 条
        </div>
        <div style={messagesStyle}>
          {messages.length === 0 ? <p style={mutedStyle}>选择 Bot 后恢复其 canonical Bot Chat。</p> : null}
          {messages.map(message => (
            <div key={message.id} style={{ ...bubbleStyle, ...(message.role === 'user' ? userBubbleStyle : {}) }}>
              <div style={roleStyle}>{message.role}</div>
              <div style={textStyle}>{message.text || '（无文本内容）'}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={composerStyle}>
        <input
          type="text"
          value={draft}
          placeholder={sessionId ? '输入消息…' : '先选择一个 Bot'}
          disabled={!sessionId || busy}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') void send() }}
          style={inputStyle}
        />
        <button type="button" disabled={!sessionId || busy || !draft.trim()} onClick={() => void send()} style={buttonStyle}>发送</button>
        <button type="button" disabled={!sessionId || busy} onClick={() => void interrupt()} style={buttonStyle}>中断</button>
      </div>

      <div style={eventsStyle}>
        <span style={sectionLabelStyle}>最近事件</span>
        <span style={mutedStyle}>{events.length ? events.slice(-4).map(item => item.type).join(' · ') : '暂无'}</span>
      </div>
      <p style={mutedStyle}>
        会话与记忆由 Hermes Gateway 持有；发送消息会写入同一条 canonical Bot Chat。
      </p>
    </div>
  )
}

const pageStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12, height: '100%', padding: 24,
  boxSizing: 'border-box', background: 'var(--dsw-alias-bg-primary)', color: 'var(--dsw-alias-label-primary)',
  overflow: 'auto',
}
const headerStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }
const kickerStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', letterSpacing: '0.04em', textTransform: 'uppercase' }
const titleStyle: CSSProperties = { margin: '2px 0 0', fontSize: 22, fontWeight: 600 }
const sectionLabelStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }
const mutedStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
const errorStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-danger, #c0392b)', fontSize: 12 }
const badgeStyle: CSSProperties = { fontSize: 12, padding: '3px 10px', borderRadius: 999 }
const badgeOkStyle: CSSProperties = { background: 'var(--dsw-alias-bg-success, #e6f4ea)', color: 'var(--dsw-alias-label-success, #1e7e34)' }
const badgeWarnStyle: CSSProperties = { background: 'var(--dsw-alias-bg-secondary)', color: 'var(--dsw-alias-label-secondary)' }
const rosterStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 }
const rowStyle: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }
const botButtonStyle: CSSProperties = {
  padding: '7px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-primary)',
  background: 'var(--dsw-alias-bg-secondary)', color: 'inherit', cursor: 'pointer', fontSize: 13,
}
const botActiveStyle: CSSProperties = { borderColor: 'var(--dsw-alias-label-primary)' }
const botMetaStyle: CSSProperties = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }
const chatAreaStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 180 }
const messagesStyle: CSSProperties = {
  flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8,
  padding: 12, borderRadius: 8, background: 'var(--dsw-alias-bg-secondary)',
}
const bubbleStyle: CSSProperties = {
  padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-primary)',
  border: '0.5px solid var(--dsw-alias-border-primary)', maxWidth: '92%', alignSelf: 'flex-start',
}
const userBubbleStyle: CSSProperties = { alignSelf: 'flex-end' }
const roleStyle: CSSProperties = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 }
const textStyle: CSSProperties = { fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const composerStyle: CSSProperties = { display: 'flex', gap: 8 }
const inputStyle: CSSProperties = {
  flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-primary)',
  background: 'var(--dsw-alias-bg-secondary)', color: 'inherit', fontSize: 13,
}
const buttonStyle: CSSProperties = {
  padding: '8px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-primary)',
  background: 'var(--dsw-alias-bg-secondary)', color: 'inherit', cursor: 'pointer', fontSize: 13,
}
const eventsStyle: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }

export { apply, inject, PANEL_ID }
