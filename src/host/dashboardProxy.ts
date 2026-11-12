import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface DashboardProxy {
  /** 供 iframe 使用的本地 origin，例如 http://127.0.0.1:55236 */
  origin: string
  /** 随机能力路径随代理重建而失效；通过已认证的 DSH Remote 交给 iframe。 */
  baseUrl: string
  close: () => Promise<void>
}

export interface DashboardTarget {
  host: string
  port: number
}

/** Hermes 的 dashboard session token 是进程内随机值，浏览器拿不到。
 *  插件 Host 在同一台机器、同一 OS 用户下读 `~/.hermes/.env` 的固定值，
 *  再由本地反代在通过访问校验后注入上游请求与 WebSocket 握手。 */
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
  const queryStart = raw.indexOf('?')
  const base = queryStart < 0 ? raw : raw.slice(0, queryStart)
  const query = queryStart < 0 ? '' : raw.slice(queryStart + 1)
  const params = new URLSearchParams(query)
  params.set('token', token)
  return `${base}?${params.toString()}`
}

/** Dashboard 用同一个全局给 HTTP / WebSocket 携带凭据。
 *  浏览器只拿到本次代理的能力值；持久 token 在通过入口校验后由 Host 替换。 */
function injectSessionToken(html: string, token: string, accessPath: string): string {
  // 某些 Hermes listener 自己也注入 token，必须替换正文里的原值，而不只是覆盖全局变量。
  html = html.replaceAll(token, accessPath.slice(1))
  const script =
    `<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(accessPath.slice(1))};` +
    `window.__HERMES_BASE_PATH__=${JSON.stringify(accessPath)};` +
    `window.__HERMES_AUTH_REQUIRED__=false;</script>`
  const head = html.indexOf('</head>')
  if (head >= 0) return `${html.slice(0, head)}${script}${html.slice(head)}`
  return `${script}${html}`
}

/** 逐条转发原始 header，替换 Host/Origin；再补上认证头。 */
function forwardHeaders(rawHeaders: string[], target: DashboardTarget, token: string, accessPath: string): string {
  const lines: string[] = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    if (!name) continue
    const lower = name.toLowerCase()
    if (lower === 'host' || lower === 'origin' || lower === 'x-hermes-session-token'
      || lower === 'x-forwarded-prefix') continue
    lines.push(`${name}: ${rawHeaders[index + 1] ?? ''}`)
  }
  lines.push(`Host: ${upstreamHost(target)}`)
  lines.push(`Origin: ${upstreamOrigin(target)}`)
  lines.push(`X-Hermes-Session-Token: ${token}`)
  lines.push(`X-Forwarded-Prefix: ${accessPath}`)
  return lines.join('\r\n')
}

/** 起一个 loopback 反代：HTTP 与 WebSocket 都转发到 Hermes Dashboard，并注入 token。 */
export async function startDashboardProxy(
  target: DashboardTarget,
  token: string,
  port = 0,
): Promise<DashboardProxy> {
  const accessPath = `/${randomBytes(32).toString('hex')}`
  const sockets = new Set<net.Socket>()
  let origin = ''

  /** HTTP 与 WS 共用入口校验；先验证原始来源，再改写上游认证。
   *  URL 使用 Hermes 原生支持的 base path，让资源/API/WS 都携带同一能力路径。 */
  function authorizedPath(request: http.IncomingMessage, upgrade = false): string | undefined {
    if (request.headers.host !== new URL(origin).host) return undefined
    if (request.headers.origin !== undefined && request.headers.origin !== origin) return undefined
    if (upgrade && request.headers.origin !== origin) return undefined
    const raw = request.url ?? ''
    if (!raw.startsWith(`${accessPath}/`) || raw.includes('\\') || raw.includes('#')) return undefined
    const url = new URL(raw, origin)
    if (url.origin !== origin || !url.pathname.startsWith(`${accessPath}/`)) return undefined
    // HTTP 仅用 header 认证，避免上游重定向把查询串里的持久 token 带回浏览器。
    if (url.searchParams.get('token') === accessPath.slice(1)) url.searchParams.delete('token')
    return `${url.pathname.slice(accessPath.length)}${url.search}`
  }

  const server = http.createServer((request, response) => {
    const path = authorizedPath(request)
    if (!path) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      response.end('Hermes 终端代理访问被拒绝')
      return
    }
    // 不转发 accept-encoding：上游若压缩，下面的 HTML 注入就没法改写正文。
    const { 'accept-encoding': _omitEncoding, ...forwarded } = request.headers
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: request.method,
        path,
        headers: {
          ...forwarded,
          host: upstreamHost(target),
          origin: upstreamOrigin(target),
          'x-hermes-session-token': token,
          'x-forwarded-prefix': accessPath,
        },
      },
      upstreamResponse => {
        const status = upstreamResponse.statusCode ?? 502
        const headers = { ...upstreamResponse.headers }
        headers['referrer-policy'] = 'no-referrer'
        // 能力入口与凭据不进入持久缓存。
        headers['cache-control'] = 'no-store'
        const rawLocation = headers.location
        for (const [name, value] of Object.entries(headers)) {
          if (typeof value === 'string') headers[name] = value.replaceAll(token, '[redacted]')
          else if (Array.isArray(value)) headers[name] = value.map(item => item.replaceAll(token, '[redacted]'))
        }
        if (rawLocation) {
          try {
            const location = new URL(rawLocation, `${upstreamOrigin(target)}${path}`)
            if (location.origin === upstreamOrigin(target)) {
              const pathname = location.pathname.startsWith(`${accessPath}/`)
                ? location.pathname : `${accessPath}${location.pathname}`
              headers.location = `${origin}${pathname}${location.search}${location.hash}`.replaceAll(token, accessPath.slice(1))
            }
          } catch {
            delete headers.location
          }
        }
        const contentType = String(headers['content-type'] ?? '')
        if (!contentType.includes('text/html')) {
          response.writeHead(status, headers)
          upstreamResponse.pipe(response)
          return
        }
        const chunks: Buffer[] = []
        upstreamResponse.on('data', chunk => chunks.push(Buffer.from(chunk)))
        upstreamResponse.on('end', () => {
          const body = Buffer.from(injectSessionToken(Buffer.concat(chunks).toString('utf8'), token, accessPath), 'utf8')
          delete headers['transfer-encoding']
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
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  // WebSocket：原样转发握手（含子协议），只在 header 里补 token。
  server.on('upgrade', (request, socket, head) => {
    const path = authorizedPath(request, true)
    if (!path) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const upstream = net.connect(target.port, target.host, () => {
      const headers = forwardHeaders(request.rawHeaders, target, token, accessPath)
      upstream.write(`${request.method ?? 'GET'} ${withSessionToken(path, token)} HTTP/1.1\r\n${headers}\r\n\r\n`)
      if (head && head.length > 0) upstream.write(head)
    })
    let handshake = Buffer.alloc(0)
    let handshakeFinished = false
    const readHandshake = (chunk: Buffer) => {
      handshake = Buffer.concat([handshake, chunk])
      const end = handshake.indexOf('\r\n\r\n')
      if (end < 0 && handshake.length <= 16384) return
      handshakeFinished = true
      upstream.off('data', readHandshake)
      // 拒绝响应可能在 Location / 正文中回显查询凭据，只允许经过确认的升级响应进入浏览器。
      if (end < 0 || end > 16384 || !/^HTTP\/1\.[01] 101(?: |\r)/.test(handshake.toString('latin1', 0, end))) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        upstream.destroy()
        return
      }
      socket.write(handshake.toString('latin1', 0, end + 4).replaceAll(token, accessPath.slice(1)), 'latin1')
      if (handshake.length > end + 4) socket.write(handshake.subarray(end + 4))
      upstream.pipe(socket)
      socket.pipe(upstream)
    }
    upstream.on('data', readHandshake)
    upstream.on('end', () => {
      if (!handshakeFinished) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
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
  origin = `http://127.0.0.1:${bound}`
  return {
    origin,
    baseUrl: `${origin}${accessPath}`,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve())
      for (const socket of sockets) socket.destroy()
    }),
  }
}
