import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import type { GatewayEvent, GatewayState, GatewayStatus } from '../shared/dto'

export interface SshTarget {
  host: string
  port: number
  user: string
}

interface AttachInfo {
  api_origin: string
  ticket: string
  instance_id: string
  profile_id: string
  ws_url: string
}

/** 远端只读 helper：credential-free discovery + 一次性 ticket + WS 目标拼装。ticket 不出本机 Host 内存。 */
const PY_HELPER = `import sys, os, json, types, subprocess
sys.path.insert(0, os.path.expanduser("~/.hermes/hermes-agent"))
os.environ["HERMES_HOME"] = os.path.expanduser("~/.hermes")
from hermes_cli import gateway_client
from hermes_cli.gateway_runtime import gateway_profile_home
from hermes_constants import get_hermes_home
v = json.loads(subprocess.check_output(
    [os.path.expanduser("~/.local/bin/hermes"), "gateway", "ensure", "--json"], text=True, timeout=30))
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

const REMOTE_CMD = [
  'VENV=$(ls -d ~/.hermes/installs/*/environments/*/venv 2>/dev/null | head -1)',
  'PYBIN="${VENV:+$VENV/bin/python}"',
  'if [ -z "$PYBIN" ]; then PYBIN=$(ls -d ~/.hermes/tools/python-*/bin/python3 2>/dev/null | head -1); fi',
  '"$PYBIN" - <<\'PY\'',
  PY_HELPER,
  'PY',
].join('\n') + '\n'

function sshArgs(target: SshTarget): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=6',
    '-o', 'StrictHostKeyChecking=no',
    '-p', String(target.port),
    `${target.user}@${target.host}`,
  ]
}

function sshExec(target: SshTarget, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshArgs(target), command], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.once('error', error => reject(error))
    child.once('close', code => {
      if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim() || `ssh 退出码 ${code}`))
    })
  })
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function waitTunnel(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const ok = await new Promise<boolean>(resolve => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false))
    })
    if (ok) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/** DSH Host 侧的 Gateway Protocol Adapter：SSH 通道 + Node 内置 WebSocket + JSON-RPC。 */
export class GatewayTransport {
  private readonly target: SshTarget
  private ws: WebSocket | null = null
  private tunnel: ChildProcess | null = null
  private readonly pending = new Map<number, Pending>()
  private events: GatewayEvent[] = []
  private seq = 0
  private state: GatewayState = 'disconnected'
  private lastError?: string
  private info?: AttachInfo

  constructor(target: SshTarget) {
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

  async connect(): Promise<void> {
    this.state = 'connecting'
    this.release()
    try {
      const raw = await sshExec(this.target, REMOTE_CMD)
      const line = raw.split('\n').filter(Boolean).pop()
      if (!line) throw new Error('远端 attach helper 没有返回数据')
      this.info = JSON.parse(line) as AttachInfo

      const remotePort = Number(new URL(this.info.api_origin).port)
      const localPort = await freePort()
      const tunnel = spawn('ssh', [
        ...sshArgs(this.target),
        '-o', 'ExitOnForwardFailure=yes',
        '-N', '-L', `${localPort}:127.0.0.1:${remotePort}`,
      ], { stdio: 'ignore' })
      this.tunnel = tunnel
      tunnel.once('error', error => {
        this.lastError = `SSH 隧道异常: ${error.message}`
        this.state = 'error'
      })
      if (!await waitTunnel(localPort)) throw new Error('SSH 端口转发未就绪')

      const ws = new WebSocket(`ws://127.0.0.1:${localPort}/api/ws`, [
        'hermes-gateway-v1',
        `hermes-gateway-ticket.${this.info.ticket}`,
      ])
      this.ws = ws
      this.bindMessages(ws)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('Gateway WebSocket 握手失败'))
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
      if (typeof id === 'number' && this.pending.has(id)) {
        const pending = this.pending.get(id)!
        this.pending.delete(id)
        if (frame.error !== undefined) {
          pending.reject(new Error(`Gateway RPC 错误: ${JSON.stringify(frame.error).slice(0, 200)}`))
        } else {
          pending.resolve(frame.result ?? {})
        }
        return
      }
      if (frame.method === 'event') {
        const params = (frame.params ?? {}) as GatewayEvent
        this.events.push(params)
        if (this.events.length > 500) this.events = this.events.slice(-500)
        return
      }
      // Gateway 主动发起的请求（approval / clarify 等）：P0 不提供交互 UI，
      // 必须明确回错，否则 Agent 会一直等一个永远不来的响应。
      if (frame.method !== undefined && id !== undefined) {
        const method = String(frame.method)
        this.events.push({
          type: 'unsupported_request',
          detail: `${method} 已被 DSH 明确拒绝（P0 未实现交互审批）`,
          method,
          requestId: id,
        })
        if (this.events.length > 500) this.events = this.events.slice(-500)
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
        this.rejectPending(new Error('Gateway 连接已断开'))
        this.releaseTunnel()
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private releaseTunnel(): void {
    if (this.tunnel) {
      this.tunnel.kill()
      this.tunnel = null
    }
  }

  private release(): void {
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState === WebSocket.OPEN) ws.close()
    this.rejectPending(new Error('Gateway 连接已重置'))
    this.releaseTunnel()
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
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Gateway RPC 超时: ${method}`))
      }, 15000)
      const finish = () => clearTimeout(timer)
      this.pending.set(id, {
        resolve: value => { finish(); resolve(value) },
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

  close(): void {
    this.release()
    this.state = 'disconnected'
  }
}
