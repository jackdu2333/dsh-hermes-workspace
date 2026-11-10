# ADR-001 采用 Hermes TUI Gateway JSON-RPC 作为唯一主接入协议

- 状态：**已采纳**（2026-11-10）
- 取代：V1.0 PRD 的 REST / 8642 双端聊天方案；README「侧边栏只做入口、不在 DSH 内渲染对话」阶段目标
- 决策者：nono 哥（用户）；调研与起草：WorkBuddy
- 事实源：本文档 + [README.md](../README.md) + [PROJECT_WORKFLOW.md](../PROJECT_WORKFLOW.md) + [实验进展与踩坑记录](EXPERIMENT-LOG.md)

## 1. 背景与目标

用户目标（2026-11-10 澄清）：

- **基础**：在 DSH 里稳定跟 Delores 等多个 Bot 持续聊，保持人格与记忆连续。
- **后续**：多 Bot 管理。
- 本机 Hermes 只是客户端外壳，**真实数据在 SSH 远端**。WorkBuddy 的 Bash 沙箱看到的 `~/.hermes` 是另一套副本（v0.23.1 / 58559），**不得作为事实源**。

已走过的路径（不再回头）：

1. 工程骨架按 V1.0 PRD 接 8642 `/v1/runs`。
2. 改接 Desktop SSH 的 headless `serve`，REST 可读但无网页 UI。
3. 需求一度收窄为「侧栏只做入口」。
4. 试 `hermes://open/` deeplink、iframe 嵌 `/chat`（Loading chat 闪烁，已撤回）。
5. README 现行阶段：系统浏览器打开同源 `/chat`。

## 2. 决策

**采用 Hermes TUI Gateway JSON-RPC（`/api/ws` + `hermes-gateway-v1`）作为 DSH 与 Hermes 之间的唯一主接入协议。**

| 维度 | 决定 |
|---|---|
| UI | DSH 原生插件（Bot 列表 / 对话 / 历史 / 工具状态） |
| 协议 | Gateway JSON-RPC；不嵌 Dashboard、不用 API Server 作主链路 |
| 远程通信 | SSH（复用 `127.0.0.1:22222`）+ 本地端口转发 Gateway 回环地址 |
| 会话 | `profiles.list` → `canonical_session` → `session.resume` 恢复原生 Bot Chat |
| 事实来源 | Hermes Gateway 为唯一事实源；DSH 不自建第二套会话 |
| 协议客户端 | 自实现最小 Node 客户端（`ws` + JSON-RPC）；不 npm 安装 `@hermes/shared` |
| 多 Bot | P0 单 Profile；P1 逐 Profile 授权连接 |
| 阶段 | 先完成 [P0-00](P0-00-gateway-validation.md) 协议验证，再进入插件 UI 开发 |

## 3. 依据

### 3.1 已验证事实（2026-11-10 实测）

- SSH 通道 `ssh -o BatchMode=yes -p 22222 jackdu@127.0.0.1` 免密可用；远端为 Hermes **v0.23.0**，用户 `jackdu`。
- 远端根 `~/.hermes/profile.yaml` 有 `ui_meta.hermes-bots`、`title: Delores` → **Bot-Mode-managed 安装**。
- `state.db` 的 `sessions.title` 列有一条 `Bot Chat`：`local-b29ce87dfe6b7cd985834af1d6858913e138a85d711bb7f2dfc876d2dc22bb6f`（source=gui / created_source=desktop / model=gpt-6-luna）。**canonical 会话真实存在，记忆连续的地基不是空的**。
- `hermes gateway ensure --json` 返回 `state=ready`、`endpoint.api_origin=http://127.0.0.1:55015`、`capabilities=[durable-admission-v1, event-replay-v1, session-authority-v1]`、`runtime_protocol=1`。
- **E0 通过**：用 Hermes 自带 Python 调 `_session_ticket` + `gateway_ws_target`，得到 `ws://127.0.0.1:55015/api/ws` 与 `["hermes-gateway-v1", "hermes-gateway-ticket.<ticket>"]`（ticket 长度 43）。**未建立 WS 连接、未发消息，ticket 未使用即过期**。详见 P0-00 第 3 节。
- `55015` 同时提供 `/chat` SPA（200）与 `/api/ws`；SPA 的 HTML 不注入 `__HERMES_SESSION_TOKEN__`，`/api/sessions` 返回 401。`60013` 是 headless `serve --isolated`，`/chat` 404。
- **只读链路 E1–E5 / E7 全部实测通过**：SSH discovery + 本地端口转发 + Node 内置 WebSocket 握手 `hermes-gateway-v1` → `runtime.describe` → `profiles.list`（1 个 profile、`bot_mode_protocol=true`、canonical 与 `state.db` 一致）→ `session.resume(defer_history=true)` 返回 14 条历史 → 收到 `gateway.ready` / `platforms.changed` 事件。最终源码 smoke test 同样通过。
- 远端 Python 验证需 Hermes venv（系统 `python3` 缺 `websockets` 且语法过旧）；`session.resume` 的 `lazy=true` 返回 `invalid_params`，应使用 `defer_history=true`。

### 3.2 源码 / 官方文档依据

- `website/docs/developer-guide/programmatic-integration.md:39`：`tui_gateway/server.py` 是方法/事件目录；任何外部主机可用相同帧经 stdio（`tui_gateway/entry.py`）或 WebSocket（`tui_gateway/ws.py`）接入。远端 v0.23.0 两个文件都在。
- `tui_gateway/methods_profiles.py:245`：`profiles.list` 返回 `canonical_session`（服务端按标题解析）。
- `tui_gateway/server.py:195-200`：方法清单含 `profiles.list`、`session.resume`、`prompt.submit`；另有 `session.interrupt`、`session.steer`，以及审批/澄清的 server→client 请求（`server_requests.py`）。
- `website/docs/developer-guide/gateway-internals.md:287,617`：ticket 30 秒过期、单次使用、绑定 instance/profile。
- `hermes_cli/web_server_boundary.py`：`hermes-gateway-v1` 与 `hermes-gateway-ticket.` 子协议前缀。
- DSH Host 已有 `node:child_process.spawn`（`src/host/HermesBridgeService.ts`），具备 SSH 子进程能力。

## 4. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| API Server `/v1` + `/api/sessions` 作主链路 | 会话独立，不能接管 Desktop/TUI/CLI 已有会话（409 `permission_denied`）；会产生第二套聊天 |
| iframe 嵌 dashboard `/chat` | 交付的是 TUI 终端不是原生 UI；Gateway listener 按设计 withhold token 使 `/api/*` 401；需额外处理 origin/token，**不值得** |
| `hermes://open/` deeplink | 只打开 App，不提供会话控制 |
| SSH 转发 headless `serve` 的 REST | 无网页 UI，且不是 Gateway 协议 |
| 复用 `@hermes/shared/gateway-client` | `apps/shared/package.json` 为 `private:true` / `0.0.0` / exports 指向 TS 源码 / engines 写「npm is refused here」，只依赖 monorepo 内部模块，**不是可安装 npm 包** |

> 关于 Dashboard：作为**设计取舍**否决（不值得嵌），但**不是技术不可能**。实测 `/chat` 无 `X-Frame-Options` / `frame-ancestors`，官方支持同源反向代理与 `dashboard.public_url` 声明其它 loopback origin。不要把「不能嵌入」写成硬约束。

## 5. 对上一版建议的三条修正（已采纳）

1. **`hermes gateway attach --json` 在远端 v0.23.0 不存在**：实测报 `'attach' is not a hermes gateway command`；子命令只有 run/ensure/start/stop/restart/status/install/uninstall/list/setup/migrate*/enroll；远端 docs 无 attach 记载。attach CLI 是 v0.23.1 新增包装。**替代入口**：`gateway ensure --json` 做 discovery + `hermes_cli/gateway_client.py:_session_ticket` mint ticket + `gateway_ws_target` 拼装；必须用 Hermes 自带 Python（系统 `python3` 会在 `gateway/session_contract.py` 因 `str | None` 报 `TypeError`）。
2. **`@hermes/shared/gateway-client` 不可 npm 安装**：改为自实现最小客户端（或 vendor 整组 TS 源码并编译）。
3. **「P0-00 只读验证」措辞不成立**：E6 `prompt.submit`、E9 `session.interrupt` 会真的写入 canonical Bot Chat，须拆分只读组 / 写入组并单独授权。

## 6. 风险与未验证项

| 项 | 状态 | 说明 |
|---|---|---|
| **E8 双端一致性** | **协议层通过 / UI 待确认** | 非 owner 的 `prompt.submit` 被 Gateway 接受并入队，消息写进与 Desktop **同一条** canonical session；16:38 二次验证 6 秒内收到 `PONG-DSH-OK` 正常模型回复、事件流完整。剩余为 Desktop 目视与 DSH 面板 UI 验收 |
| E1–E5 / E7 只读链路 | **已实测通过** | 含最终 `GatewayTransport` 的 smoke test；详见 P0-00 第 2 节 |
| E6 `prompt.submit` | **已实测通过** | 必须带非空 `submission_id`（官方客户端自动补 UUID），否则 `4001 invalid_params`；参数另有严格白名单 |
| E9 `session.interrupt` | 契约层通过 | 必须回传 `session.resume` 的 `execution_generation`，否则 `stale_generation`；未制造长任务，「中断运行中任务」未实测 |
| E10 断线恢复 | **已实测通过** | `close()` → 重新 discovery + mint → `connect()` → `resume` 同一 session id，历史不丢 |
| ticket 30s / 一次性 | 机制已确认，重连已验证 | 断线需重新 discovery + mint；P0 E10 通过 |
| 端口漂移 | 已知 | 55015 是本次实测值，Desktop 重启 / 隧道变化会漂移；不可硬编码，需每次 discovery |
| SSH 子进程长驻 | **已运行验证** | DSH 重启后 Host 拉起 `61558 → 55015` 隧道并保持 ESTABLISHED；生命周期清理仍待长稳观察 |
| 审批 / 澄清请求 | **已实现保守拒绝** | 带 id 的非 event 请求回 `-32000` 并推 `unsupported_request` 事件；交互 UI 属 P1 |
| ~~B1 远端模型 400~~ | **已自愈（16:38）** | 16:13 的两次 `400 Bad Request` 是瞬时故障；同一 provider 16:28 起恢复正常，16:38 二次验证拿到 `PONG-DSH-OK`。**无需改动 Hermes 配置** |
| **UI-01 面板带参 Remote** | **已修复 / 待刷新验收** | Client `$mount` descriptor 与 Host SRC 派生结果不一致，导致带参方法把业务参数当 `AbortSignal`；详见 P0-00 第 7 节 |
| 多 Bot | P1 | 当前远端活跃 Bot 只有 Delores（default profile 被标记为 Bot）；`profiles/` 仅有 `.deleted/obsidian` |

## 7. 后果

- README「当前阶段：侧栏只做入口」与 V1.0 PRD 的目标已被本 ADR 覆盖，且**代码已按本 ADR 完成改造**（2026-11-10）。
- `src/host` 的 REST 适配器已替换为 Gateway Protocol Adapter（`gatewayRemote.ts` + `HermesBridgeService.ts`）；Client 改为 DSH 原生 Bot 面板；旧 REST 适配器 4 个文件已清理；`cordis.patch.yml` 配置改为 SSH 目标。
- `pnpm typecheck` 与 `pnpm build` 均通过；最终源码经真实 Gateway smoke test 验证（connect → profiles.list → session.resume → events）。
- 2026-11-10 16:22 追加：DSH 重启后插件**真实运行**（已安装 bundle 与 `lib/` MD5 一致，Host 隧道在线）；写入组实测补齐三条契约修正——`prompt.submit` 带 `submission_id`、`session.interrupt` 带 `execution_generation`、Gateway 主动请求明确拒绝；Client 增加发送后历史刷新。
- **Host 是长驻进程**：本轮修复已构建进 `lib/`，但需再重启一次 DSH 才会在 Host 内生效；当前面板的「发送」仍是旧代码。
- 任何结论以远端实测为准，不以 WorkBuddy 沙箱副本或注入画像为准。

## 8. 相关文档

- [P0-00 Gateway 协议最小验证](P0-00-gateway-validation.md)
- [README.md](../README.md)、[PROJECT_WORKFLOW.md](../PROJECT_WORKFLOW.md)
