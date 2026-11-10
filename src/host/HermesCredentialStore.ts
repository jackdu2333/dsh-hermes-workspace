import { CREDENTIAL_SCOPE, API_KEY_RECORD_ID, CONNECTION_RECORD_ID } from '../shared/constants'
import type { ConnectionConfig } from '../shared/dto'

type ApiKeyRecord = { kind: 'api-key'; key?: string; env?: Record<string, string> }
type GrantRecord = { kind: 'grant'; payload: unknown }
type CredentialRecord = ApiKeyRecord | GrantRecord

type Credentials = {
  readRecord: (key: string) => Promise<CredentialRecord | undefined>
  describeRecord: (key: string) => Promise<{ configured: boolean }>
  modifyRecord: (
    key: string,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ) => Promise<unknown>
}

const TOKEN_KEY = `${CREDENTIAL_SCOPE}/${API_KEY_RECORD_ID}`
const CONNECTION_KEY = `${CREDENTIAL_SCOPE}/${CONNECTION_RECORD_ID}`

export class HermesCredentialStore {
  constructor(private readonly credentials: Credentials | undefined) {}

  async hasToken(): Promise<boolean> {
    if (!this.credentials) return false
    const info = await this.credentials.describeRecord(TOKEN_KEY)
    return info.configured
  }

  async readToken(): Promise<string | undefined> {
    if (!this.credentials) return undefined
    const record = await this.credentials.readRecord(TOKEN_KEY)
    const value = record?.kind === 'api-key' ? record.key?.trim() : undefined
    return value || undefined
  }

  async saveToken(token: string): Promise<void> {
    const value = token.trim()
    if (!value) throw new Error('Token 不能为空')
    await this.modify(TOKEN_KEY, async () => ({ kind: 'api-key', key: value }))
  }

  async readConnection(): Promise<Partial<ConnectionConfig>> {
    if (!this.credentials) return {}
    const record = await this.credentials.readRecord(CONNECTION_KEY)
    const payload = record?.kind === 'grant' ? record.payload : undefined
    if (!payload || typeof payload !== 'object') return {}
    const data = payload as Record<string, unknown>
    return {
      baseUrl: typeof data.baseUrl === 'string' ? data.baseUrl : '',
      displayName: typeof data.displayName === 'string' ? data.displayName : '',
      profile: typeof data.profile === 'string' ? data.profile : '',
    }
  }

  async saveConnection(config: ConnectionConfig): Promise<void> {
    await this.modify(CONNECTION_KEY, async () => ({
      kind: 'grant',
      payload: {
        baseUrl: config.baseUrl,
        displayName: config.displayName,
        profile: config.profile,
      },
    }))
  }

  private async modify(
    key: string,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<void> {
    if (!this.credentials) throw new Error('当前 profile 没有 Credentials 服务，无法保存连接')
    await this.credentials.modifyRecord(key, mutate)
  }
}
