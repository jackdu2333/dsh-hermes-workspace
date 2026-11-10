import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { PACKAGE_NAME, PANEL_ID, REMOTE_NAMESPACE } from '../shared/constants'
import type { NativeChatTarget, OpenNativeResult } from '../shared/dto'

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

type HermesRemote = {
  getNativeChatTarget: (signal?: AbortSignal) => Promise<RemoteResult<NativeChatTarget>>
  openNativeChat: (signal?: AbortSignal) => Promise<RemoteResult<OpenNativeResult>>
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

function remoteMethod(method: string) {
  return {
    id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' as const },
    parameters: [],
    result: { mode: 'src-json' as const },
    cancellation: { parameter: 'signal' as const },
  }
}

const TYPERT_REMOTE = {
  package: PACKAGE_NAME,
  descriptors: [remoteMethod('getNativeChatTarget'), remoteMethod('openNativeChat')],
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
    getNativeChatTarget: async () => {
      if (!remote?.getNativeChatTarget) throw new Error('Hermes Workspace 服务尚未就绪')
      return unwrap(await remote.getNativeChatTarget())
    },
    openNativeChat: async () => {
      if (!remote?.openNativeChat) throw new Error('Hermes Workspace 服务尚未就绪')
      return unwrap(await remote.openNativeChat())
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

function HermesChatPanel(props: {
  api?: {
    getNativeChatTarget: () => Promise<NativeChatTarget>
    openNativeChat: () => Promise<OpenNativeResult>
  }
}) {
  const api = props.api
  const [target, setTarget] = useState<NativeChatTarget | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    if (!api) {
      setError('Remote API 未注入')
      return
    }
    try {
      const next = await api.getNativeChatTarget()
      setTarget(next)
      setError(next.available ? null : next.errorMessage || '未找到 Hermes dashboard')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    void refresh()
  }, [api])

  if (target?.available && target.url) {
    return (
      <iframe
        title="Hermes native chat"
        src={target.url}
        style={frameStyle}
        allow="clipboard-read; clipboard-write"
      />
    )
  }

  return (
    <div style={pageStyle}>
      <div style={kickerStyle}>Hermes</div>
      <h1 style={titleStyle}>原生 Bot 对话区</h1>
      <p style={bodyStyle}>
        官方网页对话区是 `hermes dashboard` 的 `/chat`（内嵌 TUI）。当前 SSH 后端是 headless `hermes serve`，没有这套 UI。
      </p>
      {error ? <p style={errorStyle}>{error}</p> : <p style={mutedStyle}>正在查找本机 dashboard…</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={buttonStyle} onClick={() => void refresh()}>重新查找</button>
        <button type="button" style={buttonStyle} onClick={() => void api?.openNativeChat()}>在浏览器打开</button>
      </div>
    </div>
  )
}

const frameStyle: CSSProperties = { width: '100%', height: '100%', border: 'none', background: 'var(--dsw-alias-bg-primary)' }
const pageStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12, height: '100%', padding: 32,
  boxSizing: 'border-box', background: 'var(--dsw-alias-bg-primary)', color: 'var(--dsw-alias-label-primary)',
}
const kickerStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', letterSpacing: '0.04em', textTransform: 'uppercase' }
const titleStyle: CSSProperties = { margin: 0, fontSize: 22, fontWeight: 600 }
const bodyStyle: CSSProperties = { margin: 0, maxWidth: 640, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }
const mutedStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
const errorStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-danger, #c0392b)' }
const buttonStyle: CSSProperties = {
  alignSelf: 'flex-start', padding: '8px 12px', borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-primary)',
  background: 'var(--dsw-alias-bg-secondary)', color: 'inherit', cursor: 'pointer',
}

export { apply, inject, PANEL_ID }
