import { PACKAGE_NAME, API_KEY_RECORD_ID } from '../shared/constants'

type Credentials = {
  readRecord: (key: string) => Promise<{ kind?: string; key?: string } | undefined>
  describeRecord: (key: string) => Promise<{ configured: boolean }>
  modifyRecord: (
    key: string,
    mutate: (current: unknown) => Promise<{ kind: 'api-key'; key: string } | undefined>,
  ) => Promise<unknown>
}

/** 不依赖 @deepseek-ai/dsh-credentials 包解析；运行时 key 就是 owner/id 字符串。 */
const RECORD_KEY = `${PACKAGE_NAME}/${API_KEY_RECORD_ID}`

export class HermesCredentialStore {
  constructor(private readonly credentials: Credentials | undefined) {}

  async hasToken(): Promise<boolean> {
    if (!this.credentials) return false
    const info = await this.credentials.describeRecord(RECORD_KEY)
    return info.configured
  }

  async readToken(): Promise<string | undefined> {
    if (!this.credentials) return undefined
    const record = await this.credentials.readRecord(RECORD_KEY)
    const value = record?.kind === 'api-key' ? record.key?.trim() : undefined
    return value || undefined
  }

  async saveToken(token: string): Promise<void> {
    if (!this.credentials) throw new Error('当前 profile 没有 Credentials 服务')
    const value = token.trim()
    if (!value) throw new Error('Token 不能为空')
    await this.credentials.modifyRecord(RECORD_KEY, async () => ({ kind: 'api-key', key: value }))
  }
}
