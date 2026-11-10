import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { PACKAGE_NAME, PANEL_ID, REMOTE_NAMESPACE } from '../shared/constants'
import type { ConnectionStatus, PingResult } from '../shared/dto'

type HostContext = {
  logger?: { info?: (...args: unknown[]) => void }
  effect: (callback: () => () => void, label?: string) => () => void
}

/**
 * P0-00 骨架：只暴露 ping / 连接状态占位。
 * 真实 Hermes HTTP / SSE / Credentials 在 P0-02 接入，这里不假装已连通。
 *
 * 不使用 @Remote() 语法：当前 tsdown 不会转译装饰器。
 * 按 qiaomu-rss 的方式在类定义后用 Remote(name) 注册。
 */
export class HermesBridgeService extends TypertRemoteService {
  static inject = [] as const

  constructor(ctx: HostContext) {
    super(ctx as never, REMOTE_NAMESPACE)
    ctx.logger?.info?.('hermes-workspace: host bridge started')
    ctx.effect(() => () => {
      ctx.logger?.info?.('hermes-workspace: host bridge disposed')
    }, 'hermes-workspace: dispose')
  }

  async ping(): Promise<PingResult> {
    return {
      ok: true,
      plugin: PACKAGE_NAME,
      panelId: PANEL_ID,
      at: Date.now(),
    }
  }

  async getConnectionStatus(): Promise<ConnectionStatus> {
    return {
      state: 'unconfigured',
      displayName: 'Hermes',
      profile: '',
      errorCode: 'unconfigured',
      errorMessage: 'Hermes API 尚未配置。当前仅完成插件骨架。',
    }
  }
}

const prototype = HermesBridgeService.prototype as unknown as Record<string, (...args: never[]) => Promise<unknown>>
for (const name of ['ping', 'getConnectionStatus'] as const) {
  ;(Remote(name) as (value: unknown, context: unknown) => void)(prototype[name], {
    name,
    private: false,
    static: false,
    addInitializer(fn: () => void) {
      fn.call(Object.create(prototype))
    },
  })
}
