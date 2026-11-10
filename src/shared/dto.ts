/** Gateway 连接状态；ticket 一次性、30 秒过期，断线需重新 discovery + mint。 */
export type GatewayState = 'disconnected' | 'connecting' | 'online' | 'error'

export interface GatewayStatus {
  state: GatewayState
  instanceId?: string
  profileId?: string
  apiOrigin?: string
  /** 本地反代 origin：iframe 用它加载 Hermes 原生 Dashboard（已注入 dashboard token）。 */
  dashboardOrigin?: string
  errorMessage?: string
  checkedAt: number
}

export interface PingResult {
  ok: true
  plugin: string
  panelId: string
  at: number
}

/** profiles.list 收敛后的 Bot 行；canonicalSessionId 即标题恰为 Bot Chat 的会话。 */
export interface BotProfile {
  name: string
  displayName: string
  isDefault: boolean
  model: string
  description: string
  /** Bot 模式里给这个助手配的主色（ui_meta.hermes-bots.color），用于头像着色。 */
  color?: string
  canonicalSessionId?: string
}

export interface BotRoster {
  profiles: BotProfile[]
  botModeProtocol: boolean
}

/** session.resume 的展示层结构；content 可能是字符串或结构化 parts。 */
export interface ChatMessage {
  id: string
  role: string
  text: string
  /** role=tool 时的工具名（gateway 行上的 tool_name），用于渲染工具胶囊。 */
  toolName?: string
  timestamp?: string
}

export interface OpenRequest {
  id?: string
  kind?: string
  [key: string]: unknown
}

export interface ResumeResult {
  sessionId: string
  messages: ChatMessage[]
  messageCount: number
  running: boolean
  openRequests: OpenRequest[]
  subscriptionId?: string
  /** session.interrupt / steer 必须回传的执行代次，防止误中断另一个 turn。 */
  executionGeneration?: number
}

export interface PromptResult {
  accepted: boolean
  errorMessage?: string
}

export interface InterruptResult {
  accepted: boolean
  errorMessage?: string
}

/** Gateway 推来的 event 帧，只保留展示需要的字段。
 *  `payload` 的结构随 type 变化（契约见 gateway 的 contracts/events.py）：
 *  - message.delta: { text: string|null, turn_id, segment, offset }
 *  - tool.start / tool.complete: { tool_id, name, summary, ... }
 *  - message.complete: { text, outcome, usage } */
export interface GatewayEvent {
  type: string
  sessionId?: string
  payload?: Record<string, unknown>
  [key: string]: unknown
}

/** gateway 主动发来的交互请求（审批 / 提问），等用户在面板里决定。
 *  `id` 是 JSON-RPC 的 request id，回复时必须原样带回。 */
export interface PendingRequest {
  id: number | string
  /** 'approval' | 'clarify'；其他类型面板不渲染。 */
  method: string
  sessionId?: string
  params: Record<string, unknown>
  receivedAt: number
}

export interface EventsPage {
  events: GatewayEvent[]
  /** 全量对账用：卡片不在列表里即表示该请求已被后端撤回或已回复。 */
  requests: PendingRequest[]
}
