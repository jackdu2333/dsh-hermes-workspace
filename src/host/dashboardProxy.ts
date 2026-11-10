import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DashboardProxy {
  /** 供 iframe 使用的本地 origin，例如 http://127.0.0.1:55236 */
  origin: string
  close: () => Promise<void>
}

export interface DashboardTarget {
  host: string
  port: number
}

/** Hermes 的 dashboard session token 是进程内随机值，浏览器拿不到。
 *  插件 Host 在同一台机器、同一 OS 用户下读 `~/.hermes/.env` 的固定值，
 *  再由本地反代把它注入到每个请求与 WebSocket 握手里。 */
export function readDashboardToken(): string | undefined {
  const envPath = join(homedir(), '.hermes', '.env')
  let raw: string
  try {
    raw = readFileSync(envPath, 'utf8')
  } catch {
    return undefined
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('HERMES_DASHBOARD_SESSION_TOKEN=')) continue
    const value = trimmed.slice('HERMES_DASHBOARD_SESSION_TOKEN='.length).trim()
    return value || undefined
  }
  return undefined
}

function upstreamHost(target: DashboardTarget): string {
  return `${target.host}:${target.port}`
}

/** Hermes 只信任自己的 origin（CORS 与 WS 同一套规则），反代必须把它改写成目标 origin。 */
function upstreamOrigin(target: DashboardTarget): string {
  return `http://${upstreamHost(target)}`
}

/** Dashboard 的 WebSocket 用 URL 查询参数认证；HTTP 用 header，两者都要覆盖。 */
function withSessionToken(path: string | undefined, token: string): string {
  const raw = path && path.length > 0 ? path : '/'
  const [base, query = ''] = raw.split('?')
  const params = new URLSearchParams(query)
  params.set('token', token)
  return `${base}?${params.toString()}`
}

/** Dashboard 前端不是纯 HTTP 驱动：它把 token 读进 `window.__HERMES_SESSION_TOKEN__`
 *  再据此创建 `/api/ws`、`/api/pty` 等 WebSocket。这个全局只在 Electron 宿主里被注入，
 *  浏览器上下文里没有，于是终端会停在空白（日志：Session token not available）。
 *  反代在返回 HTML 时补上这个全局，前端才拿得到凭证。 */
function injectSessionToken(html: string, token: string): string {
  const script =
    `<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(token)};` +
    `window.__HERMES_AUTH_REQUIRED__=false;</script>`
  const head = html.indexOf('</head>')
  if (head >= 0) return `${html.slice(0, head)}${script}${html.slice(head)}`
  return `${script}${html}`
}

/** 逐条转发原始 header，替换 Host/Origin；再补上认证头。 */
function forwardHeaders(rawHeaders: string[], target: DashboardTarget, token: string): string {
  const lines: string[] = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    if (!name) continue
    const lower = name.toLowerCase()
    if (lower === 'host' || lower === 'origin') continue
    lines.push(`${name}: ${rawHeaders[index + 1] ?? ''}`)
  }
  lines.push(`Host: ${upstreamHost(target)}`)
  lines.push(`Origin: ${upstreamOrigin(target)}`)
  lines.push(`X-Hermes-Session-Token: ${token}`)
  return lines.join('\r\n')
}

/** 起一个 loopback 反代：HTTP 与 WebSocket 都转发到 Hermes Dashboard，并注入 token。 */
export async function startDashboardProxy(
  target: DashboardTarget,
  token: string,
  port = 0,
): Promise<DashboardProxy> {
  const server = http.createServer((request, response) => {
    // 不转发 accept-encoding：上游若压缩，下面的 HTML 注入就没法改写正文。
    const { 'accept-encoding': _omitEncoding, ...forwarded } = request.headers
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: request.method,
        path: request.url,
        headers: {
          ...forwarded,
          host: upstreamHost(target),
          origin: upstreamOrigin(target),
          'x-hermes-session-token': token,
        },
      },
      upstreamResponse => {
        const status = upstreamResponse.statusCode ?? 502
        const headers = { ...upstreamResponse.headers }
        const contentType = String(headers['content-type'] ?? '')
        if (!contentType.includes('text/html')) {
          response.writeHead(status, headers)
          upstreamResponse.pipe(response)
          return
        }
        const chunks: Buffer[] = []
        upstreamResponse.on('data', chunk => chunks.push(Buffer.from(chunk)))
        upstreamResponse.on('end', () => {
          const body = Buffer.from(injectSessionToken(Buffer.concat(chunks).toString('utf8'), token), 'utf8')
          headers['content-length'] = String(body.length)
          response.writeHead(status, headers)
          response.end(body)
        })
      },
    )
    upstream.on('error', error => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`Hermes Dashboard 反代失败：${error.message}`)
    })
    request.pipe(upstream)
  })

  // WebSocket：原样转发握手（含子协议），只在 header 里补 token。
  server.on('upgrade', (request, socket, head) => {
    const upstream = net.connect(target.port, target.host, () => {
      const headers = forwardHeaders(request.rawHeaders, target, token)
      const path = withSessionToken(request.url, token)
      upstream.write(`${request.method ?? 'GET'} ${path} HTTP/1.1\r\n${headers}\r\n\r\n`)
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const bound = typeof address === 'object' && address ? address.port : 0
  return {
    origin: `http://127.0.0.1:${bound}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
