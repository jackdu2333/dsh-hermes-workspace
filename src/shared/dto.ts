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
  lastCheckedAt?: number
  errorCode?: string
  errorMessage?: string
}

export interface PingResult {
  ok: true
  plugin: string
  panelId: string
  at: number
}
