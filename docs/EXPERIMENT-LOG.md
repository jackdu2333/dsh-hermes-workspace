# 实验进展与踩坑记录（2026-11-10）

> 本文记录**当天从「侧栏只做入口」走到「直连 Gateway 原生 Bot 会话」的完整实验链**，重点是踩过的坑及其可复现依据。
> 事实源分工：[ADR-001](ADR-001-gateway-protocol.md) 锁架构决策，[P0-00](P0-00-gateway-validation.md) 锁协议验证结论，[README](../README.md) 锁当前状态；本文是过程留痕，避免后续重复试错。
> 所有结论区分「已实测」与「待验证」。**不含任何 ticket、token、API Key 或账号凭证正文。**

## 1. 一句话现状

插件代码**已完成并构建通过**（`pnpm typecheck` / `pnpm build` = 0）：DSH 原生面板直连 Hermes TUI Gateway JSON-RPC，恢复 Delores 的 canonical Bot Chat，人格、记忆、历史连续。P0 只读组与写入组在协议层全部通过。**尚未完成的是 DSH 侧的最终 UI 目视验收**，原因是宿主环境（DSH RC 版）出现两起与插件无关的故障，详见第 5 节。

## 2. 时间线

| 时段 | 进展 |
|---|---|
| 上午 | 自建双端聊天工作区 → 接 Desktop SSH 的 REST（发现 headless `serve` 无网页 UI）→ 改为侧栏只做入口；试错 `hermes://open/` 与 iframe `/chat`，均撤回 |
| 12–14 时 | 复核「Bot Chat 只能在原生窗口」的旧结论：证伪。dashboard `/chat` 是 React SPA + xterm.js + `/api/pty`，无 `X-Frame-Options`；iframe 卡住的真实原因是 gateway listener `withhold_session_token=True` 使 `/api/*` 401 |
| 14–15 时 | 用户澄清目标：**基础是 DSH 里稳定跟 Delores 等多个 Bot 持续聊、人格与记忆连续，多 Bot 管理是后续**；并纠正「本机 Hermes 只是外壳，数据在 SSH 远端」 |
| 15 时 | 采纳 [ADR-001](ADR-001-gateway-protocol.md)：以 TUI Gateway JSON-RPC 为唯一主接入协议，否决 iframe / REST / API Server 主链路；落 [P0-00](P0-00-gateway-validation.md) 任务书 |
| 15–16 时 | E0 通过（`gateway ensure --json` + `_session_ticket`），P0 只读组 E1–E5/E7 全通；随后实施 `GatewayTransport` + DSH 原生面板，清理旧 REST 适配器 |
| 16–17 时 | 写入组 E6/E9/E10 通过；E8 数据层证明与 Desktop 共用同一条 canonical session；B1（远端模型 400）自愈，二次验证拿到正常回复；修复 UI-01 |
| 17–19 时 | DSH 启动失败诊断：定位为 **cookie 溢出导致 431**，与插件无关；随后定位「跳回开始设置页」为**账号会话过期触发 onboarding 回退**；19:02 强制重启成功 |

## 3. 现行实现（已实测）

```
DSH Client 面板 (src/client/index.tsx)
  ↕ Typert Remote（7 个方法）
DSH Host (HermesBridgeService.ts)
  ↕ GatewayTransport (src/host/gatewayRemote.ts)
SSH discovery (hermes gateway ensure --json)
  → 一次性 ticket（仅存 Host 内存）
  → ssh -N -L 本地端口转发
  → Node 内置 WebSocket，subprotocol hermes-gateway-v1
远端 Hermes Gateway /api/ws (v0.23.0)
  → profiles.list / session.resume / prompt.submit / session.interrupt / 事件流
  → canonical Bot Chat（同一 session，人格·记忆·历史连续）
```

关键实测值（脱敏）：

- 远端 Hermes **v0.23.0**，Gateway 监听 `127.0.0.1:55015`，`runtime_protocol=1`，capabilities 含 `session-authority-v1` / `event-replay-v1`。
- `profiles.list` 返回 `bot_mode_protocol=true`，`canonical_session.id` 与 `state.db` 中标题为 `Bot Chat` 的会话一致。
- `session.resume(defer_history=true)` 回放完整历史（首次 14 条，测试后 22 条），`open_requests=[]`。
- `prompt.submit` 返回 admission receipt（`status=queued`），事件 `message.start / agent.step / message.delta / message.complete`。
- 16:38 二次测试 6 秒内收到正常模型回复 `PONG-DSH-OK`，证明 B1 自愈。
- **零新增 npm 依赖**：用 Node 内置 `WebSocket` + `child_process.spawn`，未引入 `@hermes/shared/gateway-client`。

## 4. 踩坑清单

| # | 现象 | 根因 | 处理 / 防复发 |
|---|---|---|---|
| P-01 | `hermes gateway attach --json` 报 `'attach' is not a hermes gateway command` | 远端 v0.23.0 没有该 CLI 包装（v0.23.1 才加） | 用 `gateway ensure --json` 做 discovery，调远端 `hermes_cli/gateway_client.py` 的 `_session_ticket` + `gateway_ws_target`；**不升级远端版本** |
| P-02 | 以为可复用 `@hermes/shared/gateway-client` | `apps/shared/package.json` 是 `private:true` / `version 0.0.0` / 导出 TS 源码 / engines 明写 npm refused | 按协议自实现最小 Node 客户端 |
| P-03 | 远端脚本 import 报 `TypeError`（`str \| None`）或缺 `websockets` | SSH 会话默认 `python3` 太旧；`connect_gateway` 依赖 venv 内 `websockets` | 必须用 `~/.hermes/installs/*/environments/*/venv/bin/python`（或 Hermes 自带 Python 3.14） |
| P-04 | `session.resume(lazy=true)` → `invalid_params` | 该版本无此参数 | 改用 `defer_history=true` |
| P-05 | `prompt.submit` 36ms 即 `4001 invalid_params`，会话未被污染 | 缺非空 `submission_id`；官方 Desktop 在 `canonical-protocol.ts` 自动补 UUID | 用 `node:crypto` `randomUUID()` 补齐 |
| P-06 | `session.interrupt` 失败 | 缺 `execution_generation`（由 `session.resume` 返回） | Host 侧保存并回传，Client 类型同步 |
| P-07 | Gateway 主动发起的 `approval` / `clarify` 被静默丢弃 | `bindMessages` 只处理 response 与 event notification | 对带 id 的非 event 请求明确回 JSON-RPC `-32000`，并推 `unsupported_request` 事件；P0 不实现交互 UI |
| P-08 | 发完消息面板看不到新内容 | 缺少按事件刷新历史 | Client 监听事件后重新 `resumeSession` |
| P-09 | SSH helper 跑不起来 | heredoc 拼接时多一个反斜杠 | 修正 `gatewayRemote.ts` 的远端命令拼接，最终源码 smoke test 通过 |
| P-10 | **UI-01**：面板「已连接」但历史 0 条，红字 `Failed to execute 'any' on 'AbortSignal'` | Client `$mount` descriptor 手写 `parameters: []` + `cancellation:{parameter:'signal'}`；而 Host 侧 SRC **从方法签名自动派生** descriptor，`expected=0` 导致 `resumeSession(request)` 的唯一实参被当 callerSignal 传进 `AbortSignal.any()` | 带参方法声明 `parameters:[{name:'request',wire:'request',source:'json',codec:{mode:'src-json'}}]`，去掉 `cancellation`，删未使用的 `jsonCodec`。依据 DSH `app.asar` 的 `prepareInvocation` 与 SRC 派生逻辑 |
| P-11 | 所有新 turn 得到 `Your request was not processed` | 远端模型 API 返回 `400 Bad Request`，Hermes 写入 `FAILED_TURN_NOTICE`（失败 turn 兜底行，**不是模型回复**） | 与 DSH 无关；16:28 起 provider 自愈，16:38 验证正常；未改任何 Hermes 配置 |
| P-12 | 误判「收到回复」 | 脚本用 `includes('PONG-DSH')` 被测试消息自身文本命中 | 一律以 durable history 的 `role` 判定 assistant 回复 |
| P-13 | 归因把「本机无 Bot 数据」当硬缺口 | 本机 `~/.hermes` 是另一套副本 | 用户纠正后改为 SSH 远端核实；**本机副本不得作为事实源** |
| P-14 | 14:00 DSH 启动崩 `required plugin did not activate` | 旧插件凭证键 `@jackdu/dsh-hermes-workspace/default-api-key` 格式非法 | 用户 14:06 自行修正，与后续故障不是同一问题 |
| P-15 | Dashboard `/chat` 被当成 Gateway WS、`/api/sessions` 401 | gateway listener 按设计 `withhold_session_token=True` | 明确 `/chat` SPA 与 `/api/ws` 是同一 listener 的不同路径、不同认证，禁止混用 |
| P-16 | 「P0-00 只读验证」措辞不成立 | E6/E9 会真的写 canonical 会话 | 拆只读组（E1–E5/E7）与写入组（E6/E8/E9/E10）分别授权 |

## 5. DSH 宿主环境故障（与插件无关，但会挡住验收）

### 5.1 启动失败：cookie 溢出导致 431（已修复）

- **现象**：17:23 起连续 5 次 `Error: desktop welcome: Web authentication failed`，`phase: startup`，堆栈在 DSH 自己的 `connectDesktopWelcome`；renderer 无 error，插件激活记录干净。
- **链路**：`host.start()` → Node `fetch` 用 `redirect:"manual"` 拿 `303 + set-cookie`（成功）→ Electron `net.fetch(authenticatedUrl, {credentials:"include"})` 回访，非 2xx 即抛错。
- **根因**：DSH 每次启动往 `127.0.0.1` 写一条 `dsh-auth-*` cookie（30 天过期）却从不清理；**Chrome cookie 不区分端口**，新端口启动会把全部历史 cookie 带上。实测本机累积 **71 条 × 227B = 16,257B**，超过 Node 默认 `maxHeaderSize = 16,384B`，本地 Host 返回 **431**。
- **复现**：本地临时 Node server：**70 条 → HTTP 200，71 条 → HTTP 431**。与「16:33 第 70 条还能启动、17:23 第 71 条后必挂」完全吻合。
- **排除项**：插件二分诊断（从 `package.json` 摘掉 `hermes-workspace` 后仍失败，且 DSH 未写回配置）、账号凭证移走、系统代理与 launchd 代理变量（全 unset）、端口占用与僵死进程、网络可达性、`cordis.patch.yml`、Host 产物 MD5（16:33 成功启动时一致）。
- **修复**：备份 Cookies 后只保留最新一条 `dsh-auth-*`，Cookie 头降至 **227B / 1 条**。
- **复发风险**：这是 DSH `0.2.2-rc.1` 自身缺陷，每启动一次 +1 条，约 70 次后会再现；建议反馈官方或定期清理。**清理必须在 DSH 完全退出后进行**。

### 5.2 操作教训：不要在应用运行时改它的 cookie 数据库

诊断过程中曾在 DSH **运行期间**从外部 `cp` 覆盖 / `sqlite3` 删除 Cookies 行，导致 Chromium 内存中的认证态与磁盘不一致，前端被判未认证而弹回欢迎页。**这是本次最需要记住的操作错误**：以后只在进程完全退出后改，且改完立即启动验证，不做循环写操作。

另一处判据错误：用 `9230` 判断「DSH 是否启动成功」，而实际 Desktop Host 端口是每次随机的（`56367` / `58208` / `49212`）。因此一次成功的修复被误判为失败并自动回滚，后续又补了一次清理。**正确判据**：Desktop Host 进程存在 + 有一个由 `DeepSeek` 进程监听的 `127.0.0.1:<port>` + 无新增 crash 日志。

### 5.3 跳回「开始设置」页：账号态过期触发 onboarding 回退

- 源码 `needsWelcome(authentication) { return !loggedIn && !hasApiKey }`；两条都不满足就必须走欢迎页。
- `account/watchExpiry` 收到 `session-expired` 会执行 `enteredWorkspace = false; await showWelcome()` —— **事件驱动的强制回退**，这解释了「自动跳回」。
- 「开始设置」= `WELCOME_IPC.start` → `operations.startSignIn()`（浏览器 GitHub 授权），登录未完成就回到欢迎页，形成循环。
- `WELCOME_IPC.skip` 只是当次 `enterWorkspace()`；`saveApiKey` 成功会写 `hasApiKey=true` 并直接进工作区，因此**只有登录成功或配置 API Key 才能持久摆脱回退**。
- 实测 `server-credentials.json` 的 `accessTokenExpiresAt` 为 17:27:56（已过期），文件自 17:17 起未再刷新，refreshToken 有效到 12-03 但刷新流程未跑起来。
- **属于 DSH 账号态 / RC 版问题，不是插件、缓存或 cookie 溢出**；需用户在界面完成登录或填入 API Key，助手不代做。

### 5.4 其它环境依赖

- SSH `127.0.0.1:22222` 是插件连远端 Gateway 的入口，**由 Hermes Desktop 侧提供**；Hermes Desktop 未运行时该端口无监听，插件传输层会 `Connection refused`。
- 18:56 一份 `phase: running` 日志显示 `delores-agent-hooks (@deepseek-ai/dsh-hooks-claude-code)` 引用了不存在的包，导致 Host 主动停止（`dsh: warning: 1 entry did not activate`）。**未修配置**；19:02 重启后未复现。
- 19:02 强制重启成功：旧 PID `53931` 结束，新主进程 `79548` + Host `79570`，Host 监听 `127.0.0.1:58208`，无新增崩溃日志，窗口标题变为工作区名（表明进入主界面而非欢迎页）。

## 6. 仍未验证 / 待办

1. **E8 Desktop 目视**：在 Hermes Desktop 的 Bot Chat 里确认 `[DSH P0-00 E8-B]` 与 `PONG-DSH-OK` 出现（数据层已证共用同一 session）。
2. **DSH 面板 UI 验收**：UI-01 修复后刷新/重启，确认历史条数、无红字、发送与中断可用；需 DSH 主界面可见且 Hermes Desktop 提供的 SSH 端点在线。
3. **账号态**：完成登录或配置 API Key，使 `needsWelcome=false`，消除 onboarding 回退。
4. **多 Bot**：当前远端活跃 Bot 只有 Delores；`profiles.list` 逐个授权连接属于 P1。
5. **端口漂移**：Gateway 端口不可硬编码，每次 discovery；插件已实现，但 SSH 端点 `22222` 仍依赖 Desktop 运行。
6. **DSH RC 缺陷反馈**：cookie 溢出与 onboarding 回退建议向官方反馈。

## 7. 安全边界

- 不修改 Hermes Runtime 的配置、代码与数据；不升级远端版本。
- ticket 只在 Host 内存，不进日志、不传给 Client、不入文档；30 秒一次性，断线重新 discovery + mint。
- 写入组（`prompt.submit` / `session.interrupt`）只由用户点击触发；插件启动、选 Bot、恢复会话均不自动发消息。
- 文档不抄录任何密钥、token、API Key 正文。
