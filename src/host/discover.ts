import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HermesApiClient } from './HermesApiClient'

export interface DiscoveredConnection {
  baseUrl?: string
  token?: string
  displayName: string
  profile: string
}

export interface DiscoveredDashboard {
  url: string
  version?: string
}

interface GatewayConnectionsFile {
  lastUsed?: string
  connections?: Array<{
    id?: string
    kind?: string
    label?: string
    token?: { encoding?: string; value?: string }
  }>
}

/** 官方默认 9119，以及本机当前已确认带 SPA 的 dashboard 端口。 */
const SPA_CANDIDATES = [
  'http://127.0.0.1:9119',
  'http://127.0.0.1:58559',
]

export async function discoverHermesDesktop(): Promise<DiscoveredConnection> {
  const home = join(homedir(), '.hermes')
  const raw = await readFile(join(home, 'gateway-connections.json'), 'utf8')
  const doc = JSON.parse(raw) as GatewayConnectionsFile
  const ssh = (doc.connections ?? []).find((item) => item.kind === 'ssh')
    ?? (doc.connections ?? []).find((item) => item.id === doc.lastUsed)
  const token = ssh?.token?.encoding === 'plain' ? ssh.token.value?.trim() : undefined
  const spa = await discoverDashboardSpa()
  return {
    baseUrl: spa?.url?.replace(/\/chat$/, ''),
    token,
    displayName: ssh?.label || 'Hermes',
    profile: 'default',
  }
}

/** 官方原生网页对话区：`hermes dashboard` 的 `/chat`。headless `hermes serve` 不算。 */
export async function discoverDashboardSpa(): Promise<DiscoveredDashboard | undefined> {
  for (const url of SPA_CANDIDATES) {
    const found = await inspectSpa(url)
    if (found) return found
  }
  return undefined
}

async function inspectSpa(baseUrl: string): Promise<DiscoveredDashboard | undefined> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat`, {
      redirect: 'error',
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return undefined
    const html = await response.text()
    if (html.includes('Headless backend') || html.includes('web UI disabled')) return undefined
    if (!html.includes('Hermes Agent') && !html.includes('/assets/')) return undefined
    let version: string | undefined
    try {
      const status = await new HermesApiClient(baseUrl, undefined).getJson<{ version?: string }>('/api/status')
      version = status.version
    } catch {
      version = undefined
    }
    return { url: `${baseUrl.replace(/\/+$/, '')}/chat`, version }
  } catch {
    return undefined
  }
}
