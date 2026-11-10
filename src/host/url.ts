const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw Object.assign(new Error('请填写 Hermes dashboard 地址'), { code: 'unconfigured' })
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw Object.assign(new Error('地址不是合法 URL'), { code: 'incompatible' })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('只允许 http 或 https'), { code: 'incompatible' })
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('URL 不能包含用户名或密码'), { code: 'incompatible' })
  }
  const host = parsed.hostname.toLowerCase()
  if (!ALLOWED_HOSTS.has(host)) {
    throw Object.assign(new Error('P0 只允许访问本机回环地址（SSH 隧道本地端口）'), { code: 'incompatible' })
  }
  parsed.hash = ''
  parsed.search = ''
  const path = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = path === '/' ? '' : path
  return parsed.toString().replace(/\/+$/, '')
}

export function joinUrl(baseUrl: string, path: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${root}${suffix}`
}
