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

interface GatewayConnectionsFile {
  lastUsed?: string
  connections?: Array<{
    id?: string
    kind?: string
    label?: string
    token?: { encoding?: string; value?: string }
  }>
}

export async function discoverHermesDesktop(): Promise<DiscoveredConnection> {
  const home = join(homedir(), '.hermes')
  const raw = await readFile(join(home, 'gateway-connections.json'), 'utf8')
  const doc = JSON.parse(raw) as GatewayConnectionsFile
  const ssh = (doc.connections ?? []).find((item) => item.kind === 'ssh')
    ?? (doc.connections ?? []).find((item) => item.id === doc.lastUsed)
  const token = ssh?.token?.encoding === 'plain' ? ssh.token.value?.trim() : undefined
  const log = await readFile(join(home, 'logs', 'desktop.log'), 'utf8').catch(() => '')
  const urls = [...log.matchAll(/Connecting to remote Hermes backend at (http:\/\/127\.0\.0\.1:\d+)/g)]
    .map((match) => match[1])
    .reverse()
  const unique = [...new Set(urls)]
  let liveUrl: string | undefined
  for (const url of unique) {
    if (await isLive(url, token)) {
      liveUrl = url
      break
    }
  }
  return {
    baseUrl: liveUrl,
    token,
    displayName: ssh?.label || 'Hermes',
    profile: 'default',
  }
}

async function isLive(baseUrl: string, token?: string): Promise<boolean> {
  try {
    const health = await new HermesApiClient(baseUrl, token).getJson<{ ok?: boolean }>('/api/health')
    return health.ok === true
  } catch {
    return false
  }
}
