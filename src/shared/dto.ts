export type ConnectionState =
  | 'unconfigured'
  | 'checking'
  | 'online'
  | 'offline'
  | 'unauthorized'
  | 'incompatible'

export interface ConnectionStatus {
  state: ConnectionState
  displayName: string
  profile: string
  baseUrl?: string
  version?: string
  lastCheckedAt?: number
  errorCode?: string
  errorMessage?: string
  hasToken: boolean
}

export interface ConnectionConfig {
  baseUrl: string
  displayName: string
  profile: string
}

export interface SaveResult {
  ok: true
}

export interface PingResult {
  ok: true
  plugin: string
  panelId: string
  at: number
}

export interface OpenNativeResult {
  ok: boolean
  method: 'deeplink' | 'app' | 'dashboard'
  errorMessage?: string
}

export interface NativeChatTarget {
  available: boolean
  url?: string
  version?: string
  errorMessage?: string
}

export interface SessionSummary {
  id: string
  title: string
  source?: string
  updatedAt?: string
  messageCount?: number
}

export interface SessionPage {
  sessions: SessionSummary[]
  total?: number
}

export interface ChatMessage {
  id: string
  role: string
  text: string
}

export interface MessagePage {
  sessionId: string
  messages: ChatMessage[]
}
