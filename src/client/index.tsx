import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { PACKAGE_NAME, PANEL_ID, REMOTE_NAMESPACE } from '../shared/constants'
import type { ConnectionStatus, PingResult } from '../shared/dto'

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

type HermesRemote = {
  ping: (signal?: AbortSignal) => Promise<RemoteResult<PingResult>>
  getConnectionStatus: (signal?: AbortSignal) => Promise<RemoteResult<ConnectionStatus>>
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
  descriptors: [remoteMethod('ping'), remoteMethod('getConnectionStatus')],
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
  const api = {
    ping: async () => unwrap(await requireRemote(ctx).ping()),
    getConnectionStatus: async () => unwrap(await requireRemote(ctx).getConnectionStatus()),
  }

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID, inject: () => ({ api }) },
      HermesWorkspacePanel,
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 18,
        label: 'Hermes',
      },
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
  const color = props.active
    ? 'var(--dsw-alias-label-primary)'
    : 'var(--dsw-alias-label-secondary)'
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      <path
        fill={color}
        d="M12 2.5c.4 0 .7.2.9.5l1.8 3.1 3.5.6c.8.1 1.1 1.1.5 1.7l-2.6 2.6.6 3.6c.1.8-.7 1.4-1.4 1L12 14.4l-3.3 1.7c-.7.4-1.5-.2-1.4-1l.6-3.6L5.3 8.4c-.6-.6-.3-1.6.5-1.7l3.5-.6L11.1 3c.2-.3.5-.5.9-.5Z"
      />
    </svg>
  )
}

function HermesWorkspacePanel(props: { api?: typeof apiShape }) {
  const api = props.api
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [ping, setPing] = useState<PingResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) {
      setError('Remote API 未注入')
      return
    }
    let cancelled = false
    Promise.all([api.getConnectionStatus(), api.ping()])
      .then(([nextStatus, nextPing]) => {
        if (cancelled) return
        setStatus(nextStatus)
        setPing(nextPing)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [api])

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <div style={kickerStyle}>Hermes Workspace</div>
          <h1 style={titleStyle}>独立 Bot 工作区骨架</h1>
        </div>
        <StatusBadge state={status?.state ?? 'checking'} />
      </header>

      <p style={bodyStyle}>
        当前阶段只验证 DSH 原生入口、独立主面板和 Host/Client Remote ping。Hermes API、会话与流式对话尚未接入。
      </p>

      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Host 连通</h2>
        {error ? (
          <p style={errorStyle}>{error}</p>
        ) : ping ? (
          <dl style={metaStyle}>
            <div>
              <dt>plugin</dt>
              <dd>{ping.plugin}</dd>
            </div>
            <div>
              <dt>panel</dt>
              <dd>{ping.panelId}</dd>
            </div>
            <div>
              <dt>ping</dt>
              <dd>{new Date(ping.at).toLocaleString()}</dd>
            </div>
          </dl>
        ) : (
          <p style={mutedStyle}>正在调用 Host ping…</p>
        )}
      </section>

      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>连接状态</h2>
        <p style={mutedStyle}>{status?.errorMessage ?? '尚未读取。'}</p>
      </section>
    </div>
  )
}

function StatusBadge({ state }: { state: string }) {
  return <span style={badgeStyle}>{state}</span>
}

const apiShape = {
  ping: async (): Promise<PingResult> => {
    throw new Error('unbound')
  },
  getConnectionStatus: async (): Promise<ConnectionStatus> => {
    throw new Error('unbound')
  },
}

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  height: '100%',
  padding: 24,
  boxSizing: 'border-box',
  background: 'var(--dsw-alias-bg-primary)',
  color: 'var(--dsw-alias-label-primary)',
  overflow: 'auto',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
}

const kickerStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
}

const titleStyle: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 22,
  fontWeight: 600,
}

const bodyStyle: CSSProperties = {
  margin: 0,
  maxWidth: 640,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-secondary)',
}

const cardStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-primary)',
  borderRadius: 12,
  padding: 16,
  background: 'var(--dsw-alias-bg-secondary)',
}

const sectionTitleStyle: CSSProperties = {
  margin: '0 0 8px',
  fontSize: 14,
  fontWeight: 600,
}

const mutedStyle: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
}

const errorStyle: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-danger, #c0392b)',
}

const metaStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  margin: 0,
}

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '4px 10px',
  borderRadius: 999,
  fontSize: 12,
  background: 'var(--dsw-alias-bg-tertiary, var(--dsw-alias-bg-secondary))',
  color: 'var(--dsw-alias-label-secondary)',
}

export { apply, inject, PANEL_ID }
