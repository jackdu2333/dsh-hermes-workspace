import { useEffect, useState, type CSSProperties, type FormEvent, type ReactElement } from 'react'
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

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

type HermesRemote = {
  ping: (signal?: AbortSignal) => Promise<RemoteResult<PingResult>>
  getConnectionStatus: (signal?: AbortSignal) => Promise<RemoteResult<ConnectionStatus>>
  saveConnectionConfig: (request: ConnectionConfig, signal?: AbortSignal) => Promise<RemoteResult<SaveResult>>
  saveApiKey: (request: { token: string }, signal?: AbortSignal) => Promise<RemoteResult<SaveResult>>
  testConnection: (signal?: AbortSignal) => Promise<RemoteResult<ConnectionStatus>>
  listSessions: (signal?: AbortSignal) => Promise<RemoteResult<SessionPage>>
  getSessionMessages: (request: { sessionId: string }, signal?: AbortSignal) => Promise<RemoteResult<MessagePage>>
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

const jsonCodec = () => ({
  mode: 'strict' as const,
  typeSymbol: `${PACKAGE_NAME}#json`,
  create: () => ({
    parse: (value: unknown) => value,
    safeParse: (value: unknown) => ({ success: true as const, data: value }),
  }),
})

function remoteMethod(method: string, hasParams = false) {
  return {
    id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' as const },
    ...(hasParams
      ? { parameters: [{ name: 'request', wire: 'request', source: 'json', codec: jsonCodec() }] }
      : { parameters: [] }),
    result: { mode: 'src-json' as const },
    cancellation: { parameter: 'signal' as const },
  }
}

const TYPERT_REMOTE = {
  package: PACKAGE_NAME,
  descriptors: [
    remoteMethod('ping'),
    remoteMethod('getConnectionStatus'),
    remoteMethod('saveConnectionConfig', true),
    remoteMethod('saveApiKey', true),
    remoteMethod('testConnection'),
    remoteMethod('listSessions'),
    remoteMethod('getSessionMessages', true),
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
  const remote = requireRemote(ctx)
  const api = {
    ping: async () => unwrap(await remote.ping()),
    getConnectionStatus: async () => unwrap(await remote.getConnectionStatus()),
    saveConnectionConfig: async (request: ConnectionConfig) => unwrap(await remote.saveConnectionConfig(request)),
    saveApiKey: async (token: string) => unwrap(await remote.saveApiKey({ token })),
    testConnection: async () => unwrap(await remote.testConnection()),
    listSessions: async () => unwrap(await remote.listSessions()),
    getSessionMessages: async (sessionId: string) => unwrap(await remote.getSessionMessages({ sessionId })),
  }

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID, inject: () => ({ api }) },
      HermesWorkspacePanel,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 18, label: 'Hermes' },
      HermesIcon,
    ),
  )
}

function requireRemote(ctx: SlotCtx): HermesRemote {
  const namespace = ctx.remote.hermesWorkspace
  if (!namespace?.ping || !namespace.getConnectionStatus) {
    throw new Error('Hermes Workspace 服务尚未就绪')
  }
  return namespace
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

function HermesWorkspacePanel(props: { api?: typeof apiShape }) {
  const api = props.api
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [displayName, setDisplayName] = useState('Hermes')
  const [profile, setProfile] = useState('default')
  const [token, setToken] = useState('')

  async function refresh(nextApi = api) {
    if (!nextApi) {
      setError('Remote API 未注入')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const nextStatus = await nextApi.getConnectionStatus()
      setStatus(nextStatus)
      setBaseUrl((current) => current || nextStatus.baseUrl || '')
      setDisplayName(nextStatus.displayName || 'Hermes')
      setProfile(nextStatus.profile || 'default')
      if (nextStatus.state === 'online') {
        const page = await nextApi.listSessions()
        setSessions(page.sessions)
        if (page.sessions[0] && !selectedId) setSelectedId(page.sessions[0].id)
      } else {
        setSessions([])
        setMessages([])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [api])

  useEffect(() => {
    if (!api || !selectedId || status?.state !== 'online') return
    let cancelled = false
    api.getSessionMessages(selectedId).then((page) => {
      if (!cancelled) setMessages(page.messages)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      cancelled = true
    }
  }, [api, selectedId, status?.state])

  async function onSave(event: FormEvent) {
    event.preventDefault()
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      if (token.trim()) {
        await api.saveApiKey(token.trim())
        setToken('')
      }
      await api.saveConnectionConfig({ baseUrl, displayName, profile })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <div style={kickerStyle}>Hermes Workspace</div>
          <h1 style={titleStyle}>{status?.displayName || 'Hermes'}</h1>
        </div>
        <StatusBadge state={status?.state ?? 'checking'} />
      </header>
      <p style={bodyStyle}>
        接入现有 Hermes Desktop SSH dashboard（`/api/health`、`/api/sessions`）。本地端口由 Desktop 动态分配，SSH 隧道变化后需要更新地址。
      </p>
      {error ? <p style={errorStyle}>{error}</p> : null}

      <form style={cardStyle} onSubmit={onSave}>
        <h2 style={sectionTitleStyle}>连接</h2>
        <label style={labelStyle}>
          Dashboard URL
          <input style={inputStyle} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:59585" autoComplete="off" />
        </label>
        <label style={labelStyle}>
          显示名
          <input style={inputStyle} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <label style={labelStyle}>
          Profile
          <input style={inputStyle} value={profile} onChange={(event) => setProfile(event.target.value)} placeholder="default" />
        </label>
        <label style={labelStyle}>
          Session token（只在 Host 保存，不会回显）
          <input style={inputStyle} type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={status?.hasToken ? '已配置，留空则不改' : '粘贴 X-Hermes-Session-Token'} autoComplete="off" />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" style={buttonStyle} disabled={busy}>保存并检测</button>
          <button type="button" style={buttonStyle} disabled={busy} onClick={() => void refresh()}>重新检测</button>
        </div>
        <p style={mutedStyle}>{status?.errorMessage || status?.version || '尚未检测。'}</p>
      </form>

      <div style={splitStyle}>
        <section style={{ ...cardStyle, minWidth: 220 }}>
          <h2 style={sectionTitleStyle}>会话</h2>
          {sessions.length === 0 ? <p style={mutedStyle}>在线后会列出 Hermes 历史会话。</p> : (
            <ul style={listStyle}>
              {sessions.map((session) => (
                <li key={session.id}>
                  <button type="button" style={session.id === selectedId ? selectedRowStyle : rowStyle} onClick={() => setSelectedId(session.id)}>
                    <strong>{session.title || session.id}</strong>
                    <span style={mutedStyle}>{session.updatedAt || session.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section style={{ ...cardStyle, flex: 1 }}>
          <h2 style={sectionTitleStyle}>消息</h2>
          {messages.length === 0 ? <p style={mutedStyle}>选择一个会话查看历史。发送与流式输出尚未接入。</p> : (
            <div style={{ display: 'grid', gap: 12 }}>
              {messages.map((message) => (
                <article key={message.id} style={messageStyle}>
                  <div style={kickerStyle}>{message.role}</div>
                  <pre style={preStyle}>{message.text || '（无文本）'}</pre>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function StatusBadge({ state }: { state: string }) {
  return <span style={badgeStyle}>{state}</span>
}

const apiShape = {
  ping: async (): Promise<PingResult> => { throw new Error('unbound') },
  getConnectionStatus: async (): Promise<ConnectionStatus> => { throw new Error('unbound') },
  saveConnectionConfig: async (_request: ConnectionConfig): Promise<SaveResult> => { throw new Error('unbound') },
  saveApiKey: async (_token: string): Promise<SaveResult> => { throw new Error('unbound') },
  testConnection: async (): Promise<ConnectionStatus> => { throw new Error('unbound') },
  listSessions: async (): Promise<SessionPage> => { throw new Error('unbound') },
  getSessionMessages: async (_sessionId: string): Promise<MessagePage> => { throw new Error('unbound') },
}

const pageStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 16, height: '100%', padding: 24,
  boxSizing: 'border-box', background: 'var(--dsw-alias-bg-primary)', color: 'var(--dsw-alias-label-primary)', overflow: 'auto',
}
const headerStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }
const kickerStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', letterSpacing: '0.04em', textTransform: 'uppercase' }
const titleStyle: CSSProperties = { margin: '4px 0 0', fontSize: 22, fontWeight: 600 }
const bodyStyle: CSSProperties = { margin: 0, maxWidth: 720, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }
const cardStyle: CSSProperties = { border: '1px solid var(--dsw-alias-border-primary)', borderRadius: 12, padding: 16, background: 'var(--dsw-alias-bg-secondary)', display: 'grid', gap: 10 }
const sectionTitleStyle: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600 }
const mutedStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
const errorStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-danger, #c0392b)' }
const labelStyle: CSSProperties = { display: 'grid', gap: 4, fontSize: 12 }
const inputStyle: CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-primary)', background: 'var(--dsw-alias-bg-primary)', color: 'inherit' }
const buttonStyle: CSSProperties = { padding: '8px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-primary)', background: 'var(--dsw-alias-bg-tertiary, var(--dsw-alias-bg-primary))', color: 'inherit', cursor: 'pointer' }
const splitStyle: CSSProperties = { display: 'flex', gap: 16, alignItems: 'stretch', minHeight: 280 }
const listStyle: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }
const rowStyle: CSSProperties = { width: '100%', textAlign: 'left', display: 'grid', gap: 2, padding: 8, borderRadius: 8, border: '1px solid transparent', background: 'transparent', color: 'inherit', cursor: 'pointer' }
const selectedRowStyle: CSSProperties = { ...rowStyle, border: '1px solid var(--dsw-alias-border-primary)', background: 'var(--dsw-alias-bg-primary)' }
const messageStyle: CSSProperties = { display: 'grid', gap: 4 }
const preStyle: CSSProperties = { margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13 }
const badgeStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderRadius: 999, fontSize: 12, background: 'var(--dsw-alias-bg-tertiary, var(--dsw-alias-bg-secondary))', color: 'var(--dsw-alias-label-secondary)' }

export { apply, inject, PANEL_ID }
