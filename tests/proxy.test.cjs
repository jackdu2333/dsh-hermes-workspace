const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const { createHash } = require('node:crypto')
const { loadSource } = require('./helpers.cjs')

const { startDashboardProxy } = loadSource('src/host/dashboardProxy.ts').exports
const sessionToken = 'fixture-upstream-secret-0123456789'

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, { ...options, headers: { Connection: 'close', ...options.headers } }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
    })
    outgoing.on('error', reject)
    outgoing.end(options.body)
  })
}

function upgrade(proxy, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(proxy.origin)
    const socket = net.connect(Number(url.port), '127.0.0.1', () => {
      const merged = {
        Host: url.host, Upgrade: 'websocket', Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      }
      socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(merged).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
    })
    socket.once('data', data => resolve({ status: Number(data.toString().split(' ')[1]), response: data.toString('latin1'), socket }))
    socket.on('error', reject)
    socket.setTimeout(2000, () => socket.destroy(new Error('fixture handshake timed out')))
  })
}

async function fixture(t) {
  const captured = []
  const upstreamSockets = new Set()
  const upstream = http.createServer((req, res) => {
    captured.push({ method: req.method, url: req.url, headers: req.headers })
    const prefix = req.headers['x-forwarded-prefix']
    if (req.url.startsWith('/chat')) {
      res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self' 'unsafe-inline'" })
      // 模拟 Hermes 的原生 prefix 支持，以及某些 listener 已经注入原 token 的情况。
      res.end(`<html><head><script>window.__HERMES_SESSION_TOKEN__="${sessionToken}";</script><script src="${prefix}/assets/app.js"></script></head><body>fixture</body></html>`)
    } else if (req.url.startsWith('/redirect-absolute')) {
      res.writeHead(307, { location: `http://127.0.0.1:${upstream.address().port}/assets/?token=${sessionToken}` })
      res.end()
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: '/chat' })
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }
  })
  upstream.on('connection', socket => {
    upstreamSockets.add(socket)
    socket.on('close', () => upstreamSockets.delete(socket))
  })
  upstream.on('upgrade', (req, socket) => {
    captured.push({ method: 'WS', url: req.url, headers: req.headers })
    if (req.url.startsWith('/redirect-absolute')) {
      socket.end(`HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:${upstream.address().port}/assets/?token=${sessionToken}\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const target = { host: '127.0.0.1', port: upstream.address().port }
  const proxy = await startDashboardProxy(target, sessionToken)
  t.after(async () => {
    await proxy.close()
    for (const socket of upstreamSockets) socket.destroy()
    await new Promise(resolve => upstream.close(resolve))
  })
  return { proxy, target, captured, prefix: new URL(proxy.baseUrl).pathname }
}

test('proxy blocks the original unauthenticated HTTP and WS triggers before contacting upstream', async t => {
  const { proxy, captured } = await fixture(t)
  const blocked = await request(`${proxy.origin}/api/fixture`, { method: 'POST', headers: { Origin: 'http://untrusted.example' } })
  assert.equal(blocked.status, 403)
  const ws = await upgrade(proxy, '/api/pty', { Origin: 'http://untrusted.example' })
  assert.equal(ws.status, 403)
  ws.socket.destroy()
  assert.equal(captured.length, 0)
})

test('capability, Host and Origin gates apply to HTTP and WS, including alternate path forms', async t => {
  const { proxy, prefix, captured } = await fixture(t)
  const attempts = [
    { path: `${prefix}/api/fixture`, headers: { Origin: 'http://untrusted.example' } },
    { path: `${prefix}/api/fixture`, headers: { Origin: 'null' } },
    { path: `${prefix}/api/fixture`, headers: { Host: 'attacker.example' } },
    { path: `${prefix}/%2e%2e/api/fixture`, headers: {} },
    { path: `${prefix}suffix/api/fixture`, headers: {} },
    { path: '/wrong-capability/api/fixture', headers: {} },
  ]
  for (const attempt of attempts) {
    const result = await request(proxy.origin, { path: attempt.path, headers: attempt.headers, method: 'POST' })
    assert.equal(result.status, 403, attempt.path)
    const ws = await upgrade(proxy, attempt.path, { Origin: proxy.origin, ...attempt.headers })
    assert.equal(ws.status, 403, attempt.path)
    ws.socket.destroy()
  }
  const noOrigin = await upgrade(proxy, `${prefix}/api/pty`)
  assert.equal(noOrigin.status, 403)
  noOrigin.socket.destroy()
  assert.equal(captured.length, 0)
})

test('authenticated iframe, static assets and API preserve the native prefix and conceal the persistent token', async t => {
  const { proxy, prefix, target, captured } = await fixture(t)
  const page = await request(`${proxy.baseUrl}/chat?resume=fixture`)
  assert.equal(page.status, 200)
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
  assert.equal(page.body.includes(sessionToken), false)
  assert.equal(page.body.includes(`window.__HERMES_BASE_PATH__="${prefix}"`), true)
  assert.equal(page.body.includes(`src="${prefix}/assets/app.js"`), true)
  await request(`${proxy.baseUrl}/assets/app.js`)
  await request(`${proxy.baseUrl}/api/fixture`, {
    method: 'POST', headers: { Origin: proxy.origin, 'X-Hermes-Session-Token': prefix.slice(1) }, body: 'fixture',
  })
  assert.equal(captured.length, 3)
  assert.equal(captured[1].url, '/assets/app.js')
  assert.equal(captured[2].headers.origin, `http://127.0.0.1:${target.port}`)
  assert.equal(captured[2].headers['x-hermes-session-token'], sessionToken)
  assert.equal(captured[2].headers['x-forwarded-prefix'], prefix)
  assert.equal((await request(`${proxy.baseUrl}/redirect`)).headers.location, `${proxy.baseUrl}/chat`)
})

test('authenticated WS receives only upstream credentials; close terminates upgraded sockets', async t => {
  const { proxy, prefix, captured } = await fixture(t)
  const ws = await upgrade(proxy, `${prefix}/api/pty?resume=fixture&token=${prefix.slice(1)}`, {
    Origin: proxy.origin, 'X-Hermes-Session-Token': 'untrusted-duplicate', 'X-Forwarded-Prefix': '/wrong',
  })
  assert.equal(ws.status, 101)
  assert.equal(captured[0].url, `/api/pty?resume=fixture&token=${sessionToken}`)
  assert.equal(captured[0].headers['x-hermes-session-token'], sessionToken)
  assert.equal(captured[0].headers['x-forwarded-prefix'], prefix)
  await proxy.close()
  ws.socket.destroy()
})

test('recreated proxies reject the previous instance capability', async t => {
  const { proxy, target, prefix } = await fixture(t)
  const next = await startDashboardProxy(target, sessionToken)
  t.after(() => next.close())
  assert.notEqual(new URL(next.baseUrl).pathname, prefix)
  assert.equal((await request(`${next.origin}${prefix}/chat`)).status, 403)
  assert.equal((await request(`${next.baseUrl}/chat`)).status, 200)
})

test('HTTP and failed WS redirects cannot return persistent credentials to the browser', async t => {
  const { proxy, prefix, captured } = await fixture(t)
  const redirect = await request(`${proxy.baseUrl}/redirect-absolute?token=${prefix.slice(1)}`)
  assert.equal(captured[0].url, '/redirect-absolute')
  assert.equal(redirect.status, 307)
  assert.equal(redirect.headers.location, `${proxy.baseUrl}/assets/?token=${prefix.slice(1)}`)
  assert.equal(JSON.stringify(redirect).includes(sessionToken), false)
  const ws = await upgrade(proxy, `${prefix}/redirect-absolute?token=${prefix.slice(1)}`, { Origin: proxy.origin })
  assert.equal(ws.status, 502)
  assert.equal(ws.response.includes(sessionToken), false)
  ws.socket.destroy()
})
