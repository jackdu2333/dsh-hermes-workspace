/** 插件包名，与 package.json name 一致。 */
export const PACKAGE_NAME = '@jackdu/dsh-hermes-workspace'

/** Loader 行 id / 左侧面板 id / main keyed slot key。 */
export const PANEL_ID = 'hermes-workspace'

/** Typert Remote namespace，Client 通过 ctx.remote.hermesWorkspace 访问。 */
export const REMOTE_NAMESPACE = 'hermesWorkspace'

/** 凭据记录 id；完整 key 为 `@jackdu/dsh-hermes-workspace/default-api-key`。 */
export const API_KEY_RECORD_ID = 'default-api-key'

/** 连接配置记录（不含密钥正文以外的 token 时仍走 Credentials）。 */
export const CONNECTION_RECORD_ID = 'connection'
