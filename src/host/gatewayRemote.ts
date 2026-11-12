import { spawn } from 'node:child_process'
import type { GatewayEvent, GatewayState, GatewayStatus, PendingRequest } from '../shared/dto'

export interface GatewayTarget {
  /** 本机 Hermes profile 名，对应 `hermes --profile <name>`。 */
  profile: string
}

interface AttachInfo {
  api_origin: string
  ticket: string
  instance_id: string
  profile_id: string
  ws_url: string
}

/** 本机只读 helper：discovery + 一次性 ticket + WS 目标拼装。ticket 不出本机 Host 内存。 */
const PY_HELPER = `import sys, os, json, types, subprocess
sys.path.insert(0, os.path.expanduser("~/.hermes/hermes-agent"))
os.environ["HERMES_HOME"] = os.path.expanduser("~/.hermes")
from hermes_cli import gateway_client
from hermes_cli.gateway_runtime import gateway_profile_home
from hermes_constants import get_hermes_home
profile = os.environ.get("HERMES_DSH_PROFILE") or "default"
v = json.loads(subprocess.check_output(
    [sys.executable, "-m", "hermes_cli.main", "--profile", profile, "gateway", "ensure", "--json"],
    text=True, timeout=30, stderr=subprocess.DEVNULL))
if v.get("state") != "ready" or not (v.get("endpoint") or {}).get("api_origin"):
    raise SystemExit("gateway not ready: " + str(v.get("reason_code")))
ep_raw = v["endpoint"]
ep = types.SimpleNamespace(**{k: ep_raw.get(k) for k in (
    "api_origin", "authority_epoch", "capabilities", "code_sha", "control_home",
    "instance_id", "profile_id", "runtime_protocol", "supervisor")})
ticket = gateway_client._session_ticket(gateway_profile_home(get_hermes_home()), ep)
url, protocols = gateway_client.gateway_ws_target(ep, ticket)
print(json.dumps({"api_origin": ep.api_origin, "ticket": ticket,
                  "instance_id": ep.instance_id, "profile_id": ep.profile_id, "ws_url": url}))
`

/** 本机 Hermes 自带 python 的定位顺序：venv → tools 下的解释器。 */
const LOCAL_CMD = [
  'VENV=$(ls -d ~/.hermes/installs/*/environments/*/venv 2>/dev/null | head -1)',
  'PYBIN="${VENV:+$VENV/bin/python}"',
  'if [ -z "$PYBIN" ]; then PYBIN=$(ls -d ~/.hermes/tools/python-*/bin/python3 2>/dev/null | head -1); fi',
  'if [ -z "$PYBIN" ]; then echo "未找到 Hermes 自带的 python 解释器" >&2; exit 1; fi',
  'export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"',
  'export PYTHONPATH="$HERMES_HOME/hermes-agent${PYTHONPATH:+:$PYTHONPATH}"',
  '"$PYBIN" - <<\'PY\'',
  PY_HELPER,
  'PY',
].join('\n') + '\n'

function localExec(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], { stdio: ['ignore', 'pipe', 'pipe'], env })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.once('error', error => reject(error))
    child.once('close', code => {
      if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim().split('\n').pop() || `本地 helper 退出码 ${code}`))
    })
  })
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/** DSH Host 侧的 Gateway Protocol Adapter：本机直连 + Node 内置 WebSocket + JSON-RPC。 */
export class GatewayTransport {
  private readonly target: GatewayTarget
  private ws: WebSocket | null = null
  private readonly pending = new Map<number, Pending>()
  private events: GatewayEvent[] = []
  /** 还等着用户决定的交互请求。面板每轮轮询取全量，用户点了才回包。 */
  private requests: PendingRequest[] = []
  /** 快照读取期间仍会收到实时撤回；保留变更版本，避免迟到快照复活失效卡片。 */
  private requestVersion = 0
  private readonly requestUpdates = new Map<string, number>()
  private seq = 0
  private state: GatewayState = 'disconnected'
  private lastError?: string
  private info?: AttachInfo

  constructor(target: GatewayTarget) {
    this.target = target
  }

  get status(): GatewayStatus {
    return {
      state: this.state,
      instanceId: this.info?.instance_id,
      profileId: this.info?.profile_id,
      apiOrigin: this.info?.api_origin,
      errorMessage: this.lastError,
      checkedAt: Date.now(),
    }
  }

  private connecting?: Promise<void>
  private lastAttemptAt = 0

  /** Hermes gateway 每次重启都会换端口（`gateway ensure` 返回新地址），
   *  连接断了以后必须能自己恢复，否则面板会一直停在「连接失败」、
   *  只能靠重启整个 DSH 才能好。这里做节流的自动重连：
   *  - 已在线或正在连：直接复用；
   *  - 两次尝试之间至少间隔 minIntervalMs，避免面板 1.5s 轮询打爆 helper 进程。 */
  ensureConnected(minIntervalMs = 4000): Promise<void> | undefined {
    if (this.state === 'online') return undefined
    if (this.connecting) return this.connecting
    const now = Date.now()
    if (now - this.lastAttemptAt < minIntervalMs) return undefined
    this.lastAttemptAt = now
    this.connecting = this.connect()
      .catch(() => undefined)
      .finally(() => {
        this.connecting = undefined
      })
    return this.connecting
  }

  async connect(): Promise<void> {
    this.state = 'connecting'
    this.release()
    try {
      const raw = await localExec(LOCAL_CMD, { ...process.env, HERMES_DSH_PROFILE: this.target.profile })
      const line = raw.split('\n').filter(Boolean).pop()
      if (!line) throw new Error('本机 attach helper 没有返回数据')
      this.info = JSON.parse(line) as AttachInfo
      if (!this.info.ws_url) throw new Error('未获取到 Gateway WebSocket 地址')

      const ws = new WebSocket(this.info.ws_url, [
        'hermes-gateway-v1',
        `hermes-gateway-ticket.${this.info.ticket}`,
      ])
      this.ws = ws
      this.bindMessages(ws)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error(`Gateway WebSocket 握手失败（${this.info?.ws_url}）`))
      })
      if (ws.protocol !== 'hermes-gateway-v1') {
        throw new Error(`Gateway 协议不匹配: ${ws.protocol}`)
      }
      this.state = 'online'
      this.lastError = undefined
    } catch (error) {
      this.state = 'error'
      this.lastError = error instanceof Error ? error.message : String(error)
      this.release()
      throw error
    }
  }

  private bindMessages(ws: WebSocket): void {
    ws.onmessage = event => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(String(event.data)) as Record<string, unknown>
      } catch {
        return
      }
      const id = frame.id
      // 只有「带 id 且没有 method」才是我们自己发出去的 RPC 的响应。
      // server→client 的审批请求同样带 id，不区分会把它误当成响应吞掉。
      if (typeof id === 'number' && frame.method === undefined && this.pending.has(id)) {
        const pending = this.pending.get(id)!
        this.pending.delete(id)
        if (frame.error !== undefined) {
          pending.reject(new Error(`Gateway RPC 错误: ${JSON.stringify(frame.error).slice(0, 200)}`))
        } else {
          pending.resolve(frame.result ?? {})
        }
        if (this.pending.size === 0) this.requestUpdates.clear()
        return
      }
      if (frame.method === 'event') {
        const params = (frame.params ?? {}) as GatewayEvent
        const payload = params.payload ?? {}
        const sessionId = params.session_id ?? params.sessionId
        // 后端撤回请求时同步清卡片，否则用户会对一个已失效的审批点「允许」。
        if (params.type === 'request.cancel') {
          const cancelled = String(payload.id ?? '')
          this.removeRequests(item => String(item.id) === cancelled && (!sessionId || item.sessionId === sessionId))
          this.requestUpdates.set(JSON.stringify(['rpc', sessionId, payload.id]), ++this.requestVersion)
        } else if (params.type === 'approval.request' || params.type === 'clarify.request') {
          const request = this.canonicalRequest({ ...payload, kind: params.type.split('.')[0] }, sessionId, params.execution_generation)
          if (request) this.storeRequest(request)
        } else if (params.type === 'approval.settled' || params.type === 'clarify.settled') {
          this.removeRequests(item => item.protocol === 'canonical'
            && String(item.id) === String(payload.prompt_id)
            && item.sessionId === sessionId
            && (payload.execution_generation === undefined || item.executionGeneration === payload.execution_generation))
          this.requestUpdates.set(JSON.stringify(['canonical', sessionId, payload.prompt_id]), ++this.requestVersion)
        }
        this.events.push(params)
        // 流式时 message.delta 是逐 token 来的，500 条在长回答里会被顶掉。
        if (this.events.length > 2000) this.events = this.events.slice(-2000)
        return
      }
      // Gateway 主动发起的请求。审批与提问要渲染成卡片；其余（sudo 密码、secret、
      // vault、预览桥）本面板没有对应 UI，仍要明确回错，否则 Agent 会一直等。
      if (frame.method !== undefined && id !== undefined) {
        const method = String(frame.method)
        const params = (frame.params ?? {}) as Record<string, unknown>
        if (method === 'approval' || method === 'clarify') {
          this.storeRequest({
            id: id as number | string,
            method,
            sessionId: typeof params.session_id === 'string' ? params.session_id : undefined,
            params,
            receivedAt: Date.now(),
          })
          this.events.push({ type: 'request.open', method, requestId: String(id) })
          return
        }
        this.events.push({
          type: 'unsupported_request',
          detail: `${method} 已被 DSH 明确拒绝（面板暂未实现该交互）`,
          method,
          requestId: id,
        })
        if (this.events.length > 2000) this.events = this.events.slice(-2000)
        try {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: `DSH client does not support request: ${method}` },
          }))
        } catch {
          // 连接已关闭时无需再拒绝；onclose 会负责清理。
        }
      }
    }
    ws.onclose = () => {
      if (this.ws === ws) {
        this.state = 'disconnected'
        this.ws = null
        this.requests = []
        this.requestUpdates.clear()
        this.rejectPending(new Error('Gateway 连接已断开'))
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private release(): void {
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState === WebSocket.OPEN) ws.close()
    this.requests = []
    this.requestUpdates.clear()
    this.rejectPending(new Error('Gateway 连接已重置'))
  }

  private async ensureOpen(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws
    await this.connect()
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(this.lastError ?? 'Gateway 未连接')
    }
    return this.ws
  }

  async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = await this.ensureOpen()
    const id = ++this.seq
    const requestVersion = this.requestVersion
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Gateway RPC 超时: ${method}`))
      }, 15000)
      const finish = () => clearTimeout(timer)
      this.pending.set(id, {
        resolve: value => {
          finish()
          if (method === 'session.resume') this.restoreRequests(value, String(params.session_id ?? ''), requestVersion)
          resolve(value)
        },
        reject: error => { finish(); reject(error) },
      })
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      } catch (error) {
        finish()
        this.pending.delete(id)
        reject(error)
      }
    })
    return result as T
  }

  drainEvents(): GatewayEvent[] {
    const drained = this.events
    this.events = []
    return drained
  }

  /** 全量返回：面板轮询时用它对账，卡片消失即请求已被撤回。 */
  listRequests(): PendingRequest[] {
    return this.requests
  }

  private requestKey(request: PendingRequest): string {
    return JSON.stringify([request.protocol ?? 'rpc', request.sessionId, request.id])
  }

  private storeRequest(request: PendingRequest): void {
    const key = this.requestKey(request)
    this.requests = this.requests.filter(item => this.requestKey(item) !== key)
    this.requests.push(request)
    this.requestUpdates.set(key, ++this.requestVersion)
  }

  private removeRequests(matches: (request: PendingRequest) => boolean): void {
    this.requests = this.requests.filter(item => {
      if (!matches(item)) return true
      this.requestUpdates.set(this.requestKey(item), ++this.requestVersion)
      return false
    })
  }

  private canonicalRequest(
    prompt: Record<string, unknown>,
    sessionId: string | undefined,
    generation?: unknown,
  ): PendingRequest | undefined {
    const method = prompt.kind
    const executionGeneration = prompt.execution_generation ?? generation
    if ((method !== 'approval' && method !== 'clarify') || typeof prompt.prompt_id !== 'string'
      || !sessionId || !Number.isSafeInteger(executionGeneration)) return undefined
    const params = method === 'clarify'
      ? { ...prompt, session_id: sessionId, questions: [{
        qid: prompt.prompt_id, question: prompt.question, choices: prompt.choices, multi_select: prompt.multi_select,
      }] }
      : { ...prompt, session_id: sessionId, request_id: prompt.prompt_id }
    return {
      id: prompt.prompt_id, method, sessionId, params, protocol: 'canonical',
      executionGeneration: executionGeneration as number, receivedAt: Date.now(),
    }
  }

  private restoreRequests(value: unknown, requestedSession: string, version: number): void {
    if (!value || typeof value !== 'object') return
    const snapshot = value as Record<string, unknown>
    const sessionId = typeof snapshot.session_id === 'string' ? snapshot.session_id : requestedSession
    const restored: PendingRequest[] = []
    for (const raw of Array.isArray(snapshot.open_requests) ? snapshot.open_requests : []) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      if ((row.method !== 'approval' && row.method !== 'clarify')
        || (typeof row.id !== 'string' && typeof row.id !== 'number')) continue
      const params = row.params && typeof row.params === 'object' ? row.params as Record<string, unknown> : {}
      restored.push({
        id: row.id, method: row.method, sessionId, params: { ...params, session_id: sessionId }, receivedAt: Date.now(),
      })
    }
    for (const raw of Array.isArray(snapshot.prompts) ? snapshot.prompts : []) {
      if (!raw || typeof raw !== 'object') continue
      const request = this.canonicalRequest(raw as Record<string, unknown>, sessionId, snapshot.execution_generation)
      if (request) restored.push(request)
    }
    const changed = new Set([...this.requestUpdates].filter(([, updated]) => updated > version).map(([key]) => key))
    this.removeRequests(item => item.sessionId === sessionId && !changed.has(this.requestKey(item)))
    for (const request of restored) {
      if (!changed.has(this.requestKey(request))) this.storeRequest(request)
    }
  }

  /** 按请求原协议回复：canonical 使用代次围栏，反向 RPC 保留服务端原 id。 */
  async respond(id: number | string, result: Record<string, unknown>): Promise<void> {
    const request = this.requests.find(item => String(item.id) === String(id))
    if (!request) throw new Error('该请求已失效（可能已超时或被撤回）')
    if (request.protocol === 'canonical') {
      const params = {
        session_id: request.sessionId, prompt_id: request.id, execution_generation: request.executionGeneration,
      }
      if (request.method === 'approval') {
        if (!Array.isArray(request.params.choices) || !request.params.choices.includes(result.choice)) {
          throw new Error('该审批选项不在服务端允许的范围内')
        }
        await this.rpc('approval.respond', { ...params, choice: result.choice })
      } else {
        const answers = result.answers as Record<string, unknown> | undefined
        const answer = answers?.[String(request.id)]
        await this.rpc('clarify.respond', { ...params, answer: typeof answer === 'string' ? answer : '' })
      }
    } else {
      const ws = await this.ensureOpen()
      if (!this.requests.includes(request)) throw new Error('该请求已失效，请等待连接恢复')
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    }
    this.removeRequests(item => item === request)
  }

  /** 面板无法回答的交互：明确回错，别让 agent 一直等。 */
  async reject(id: number | string, message: string): Promise<void> {
    const index = this.requests.findIndex(item => String(item.id) === String(id))
    if (index < 0) return
    const ws = await this.ensureOpen()
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }))
    this.removeRequests(item => item === this.requests[index])
  }

  close(): void {
    this.release()
    this.state = 'disconnected'
  }
}
