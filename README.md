# Hermes Workspace

> **2026-11-10 现行决策**：见 [ADR-001](docs/ADR-001-gateway-protocol.md)——DSH 原生 UI 直连 Hermes TUI Gateway JSON-RPC；[P0-00](docs/P0-00-gateway-validation.md) 已执行完毕，UI 已实施。
> 当前阶段：**Gateway Protocol Adapter 已在 DSH 中运行**；现行状态见下方「当前状态（现行）」，标题带「历史」的段落只作留痕。
> 插件包名：`@jackdu/dsh-hermes-workspace`　面板 ID：`hermes-workspace`　版本：`0.1.26`
>
> **0.1.4 起改为本机直连**：不再走 SSH / 端口转发，直接对接本机已运行的 Hermes gateway。
> **0.1.17 起形态定案**：默认自建气泡对话；「终端」模式内嵌 Hermes TUI。原生桌面端 UI 无法 iframe（原因见「界面形态定案」）。

## 界面形态定案（2026-11-10 22:20，0.1.17）

> 用户目标：要 Hermes「Bot 模式」那种左侧 BOTS、右侧气泡聊天 + 输入框的界面。
> 结论：**该界面无法内嵌**，因为它不是 Web 页面。

| 界面 | 来源 | 能否 iframe |
|---|---|---|
| 用户截图那种气泡聊天（BOTS 侧栏） | Hermes **桌面端** Electron 渲染层 `~/.hermes/hermes-agent/apps/desktop/dist` | **不能**：代码里 190+ 处依赖 `window.hermesDesktop` 预加载桥，iframe 无该桥直接起不来 |
| Web Dashboard `/chat` | gateway 的 `hermes_cli` Web 前端 | 能，但它是 **xterm 终端 TUI**，不是气泡 UI |
| `/bots` | 无此路由，回落 `/sessions` | 主区全黑，早已弃用 |

**因此现行形态**：

- 默认视图 = 插件自建气泡对话（左 Bot 列表 / 右消息流 + 胶囊输入框）；
- 右上角「终端 / 对话」切换：终端 = 内嵌 `/chat?resume=<sessionId>` 的 Hermes TUI（提示用户点黑色区域输入）；
- 界面参考 beautifului.dev 的 AI 原生风格：小字号、弱边框、胶囊 chip、悬停才出现的消息操作。

**已实现的对话能力**：Markdown 渲染、工具调用折叠胶囊（显示 `tool_name` + 结果摘要）、消息复制 / 用户消息重发、模型徽标（只读）、自动重连。

## 多 Bot 对话（2026-11-10 22:40，0.1.24）

> 用户反馈：只能跟第一个 Bot 聊，第二个「OB 笔记助手」是灰的点不动。

根因不在 UI，而在 **Hermes 的连接模型**：

- 每个 Bot = 一个 Hermes profile，**每个 profile 跑独立 gateway 实例**（`gateway ensure --profile <name>` 返回各自 `api_origin`）。
- WS 连接只服务它自己那个 profile：用 default 的连接去调 `session.create` 会返回 `profile_mismatch`；`profiles.list` 也只能读到 default 自己的 `canonical_session`，其他 profile 恒为 `null`。
- 插件此前只用一条 default 连接，于是第二个 Bot 的 `canonicalSessionId` 永远是空 → 列表项被 `disabled` 置灰。实测连上 `obsidian-notes` 自己的 gateway 后，它有 27 条历史。

现行实现：

| 位置 | 做法 |
|---|---|
| `HermesBridgeService` | `Map<profile, GatewayTransport>`，同一 profile 复用连接；所有 RPC 带 `profile` 路由 |
| `openBot(profile)` | 连目标 gateway → `profiles.list` 读 canonical（识别依据是标题 `Bot Chat`）→ 没有就 `session.create {title:'Bot Chat', source:'gui', follow_profile_config:true}` → resume |
| `getBotRoster` | 只读 default 的 profile 目录，不逐个握手（N 个 Bot 拉起 N 个 gateway 太重），可点性不再依赖 `canonicalSessionId` |
| 显示名 | 取 `ui_meta["hermes-bots"].title`；`display_name` 是空的，所以 Delores / OB 笔记助手 都来自这里 |

已验证：点第二个 Bot 能载入它自己的 27 条历史；用户手动发消息正常，执行步骤正常折叠显示。

## 流式输出（2026-11-10 22:52，0.1.26）

Gateway 的 WS 一直在推增量帧，只是之前被整段轮询盖住了。真实抓到的 turn：

```
message.start {}
agent.step {iteration:1}
thinking.delta {text:"( •_•)>⌐■-■ brainstorming..."}
message.delta {text:"\n\n我是", turn_id, segment:0, offset:0}
message.delta {text:"运行",  turn_id, segment:0, offset:4}
message.delta {text:null}                      ← 段落边界
tool.start {tool_id, name}
tool.complete {tool_id, name, summary}
message.complete {text, outcome, usage}
```

关键语义：

| 字段 | 含义 | 用法 |
|---|---|---|
| `text: null` | segment boundary（工具调用前的收尾） | 关闭当前文本块，后续另起一段 |
| `segment` | 段号 | 同段追加、异段新建 |
| `offset` | 该 chunk 在段内的**起点**（UTF-16 码元） | `offset < 已累积长度` = 重发帧，丢弃 |
| `turn_id` | 一次 turn 的标识 | 断线重放时判断是不是同一轮 |

落地方案：

- **Host**：`getEvents` 只放行流式相关事件（`message.*` / `tool.*` / `session.*` / `agent.step` / `error`）。`sessions.changed`、`platforms.changed` 是高频广播，在 160ms 轮询下会把 delta 挤掉。
- **Client**：`applyEvents` 把帧折成 `blocks`（text / tool 按到达顺序）。草稿放 `ref` 里累积，`liveVersion` 只负责触发重绘，避免每片 delta 都 clone 状态。
- **分段**：`tool.start` 和 `message.interim` 都会清空 `segment → block` 映射。gateway 可能复用同一个 segment 号，不清就会把工具后的文本接到调用前的旁白末尾（用例里真踩到了）。
- **节奏**：有草稿时轮询 160ms，空闲退回 1.2s；状态灯单独 1.2s，不走流式节奏。
- **收尾**：`message.complete` 停光标但保留草稿，等历史刷新拿到真消息后再收，避免中间闪空；`session.info` 的 `running:false` 作为 complete 丢帧时的兜底。
- **乐观发送**：submit 成功后立即插入用户消息并进入流式等待，不再等 1.8 秒的历史刷新。

验证：本地临时脚本 `dist/verify-stream.mjs`（与 `applyEvents` 同一套折叠逻辑，不入库）用真实帧序列 + 边界用例覆盖拼接、去重、分段、工具插入、interim 去重，7/7 通过。

**待办**：模型选择器（`/api/model/set` 仅对新会话生效，运行中会话需终端 `/model`）、附件上传（`/api/chat/image-upload`）。

## 原生界面内嵌（2026-11-10 21:50，0.1.9，已被上节取代）

> 目标：不再重写聊天 UI，直接把 Hermes 原生 Dashboard（BOTS + Bot 对话）嵌进 DSH 面板。
> 面板右上角可切换「原生 / 精简」：原生 = iframe 内嵌完整 Dashboard，精简 = 本插件自己的对话界面。

**Hermes 的认证真相**（查源码 + 实测）：

| 层 | 规则 |
|---|---|
| dashboard token | `resolve_session_token()` 返回 `secrets.token_urlsafe(32)`，**进程内随机**；未设 `HERMES_DASHBOARD_SESSION_TOKEN` 时浏览器永远拿不到 |
| HTTP API | 认 header `X-Hermes-Session-Token`（或 `Authorization: Bearer`）；SPA 外壳 HTML **不注入** token |
| WebSocket `/api/ws` | 认 **URL 查询参数 `?token=`**，且校验 `Origin` 必须是 Dashboard 自己的 origin |
| CORS / Origin | 只信任自己的 origin（源码注释：任意本地端口会让别的页面读到 session token） |

**解法**（`src/host/dashboardProxy.ts`）：

1. 在 `~/.hermes/.env` 设置固定 `HERMES_DASHBOARD_SESSION_TOKEN`（43 字符，已备份原文件），重启 gateway 生效。
2. Host 连上 gateway 后起一个 loopback 反代，把请求转给真实端口，并做三件事：
   - 改写 `Host` / `Origin` 为目标 origin；
   - HTTP 注入 `X-Hermes-Session-Token`；
   - WebSocket 的请求行追加 `?token=<token>`。
3. `GatewayStatus.dashboardOrigin` 下发反代地址，Client 的 iframe 指向 `${dashboardOrigin}/bots`。

**验证**：`curl -H "Sec-WebSocket-*" "http://127.0.0.1:<gw>/api/ws?token=<token>"` + 正确 Origin → **101 Switching Protocols**；不带 token → 403。反代上 `/api/profiles` 从 401 变 **200**。

**注意**：iframe 默认停在 Sessions 页；点会话卡片会走 `/chat?resume=<sessionId>`。`/bots` 不是真实路由，SPA 对未知路径回落到 Sessions。

## 本地直连改造（2026-11-10 21:22，0.1.4）

> 触发：用户指出本机已有 Hermes agent，不需要 remote。见下方 I-06～I-08。

| 编号 | 缺陷 | 修复 |
|---|---|---|
| I-06 | 面板注册绑在 `$mount` 成功之后，`$mount` 一失败侧边栏入口和面板一起消失，用户在界面上没有任何可点入口 | `apply()` 改为「无条件注册面板 + 挂载失败写进面板」。`dist/verify-client.cjs` 同步校验 |
| I-07 | **`Cannot read properties of undefined (reading 'length')` 的真根因**：DSH `validateCodec` 要求 strict codec 的 `typeSymbol` 非空，而 descriptor 的 `parameters[].codec` / `result` 只给了 `mode + create`，`undefined.length` 直接抛错。堆栈首帧 `at validateNonempty` 是定位关键 | 补齐 `typeSymbol`（`<包名>#<namespace>/<method>:<参数名或 result>`）；同时按官方 `createTypertRemoteInfo` 产出补齐 `methods` 映射与 `input`/`invoke` |
| I-08 | `cannot get property "remote.hermesWorkspace" without inject`：Cordis 只允许访问 inject 声明过的服务，而代码在 `apply` 里直接读 `ctx.remote.hermesWorkspace` | 改为 `ctx.inject(['remote.hermesWorkspace'], child => holder.current = ...)` 延迟绑定，面板注册不等服务就绪 |

**传输层改造**（`src/host/gatewayRemote.ts`）：

- 删除 `sshExec` / `ssh -L` 隧道 / `freePort` / `waitTunnel`；改为 `bash -lc` 本地执行 attach helper。
- 本机 discovery 用 `python -m hermes_cli.main --profile <name> gateway ensure --json`（原先依赖不存在的 `~/.local/bin/hermes`），`PYTHONPATH` 指向 `~/.hermes/hermes-agent`。
- 直接连 helper 返回的 `ws_url`（本机为 `ws://127.0.0.1:55235/api/ws`），子协议 `hermes-gateway-v1` + `hermes-gateway-ticket.<ticket>`。
- 配置项 `sshHost/sshPort/sshUser` → `profile`（默认 `default`），`cordis.patch.yml` 同步。

**端到端验证**（`dist/verify-local-gateway.mjs`，不经过 DSH、不经过 SSH）：

```
ATTACH  api_origin = http://127.0.0.1:55235
WS      协议 = hermes-gateway-v1
RPC      profiles.list -> 2 个 profile（default / obsidian-notes）
RPC      session.resume -> 73 条消息，revision=3, generation=2
RESULT   PASS
```

> RPC 方法名以 Hermes 源码为准：`profiles.list` / `session.resume`（单数）/ `prompt.submit` / `session.interrupt`。

**真实界面验收**：面板显示「已连接」，Bot 列表 `default`（可恢复会话）/ `obsidian-notes`，会话历史 73 条真实消息，无红色报错。

## 本轮修复：安装与启动可靠性（2026-11-10 20:45）

> 触发：用户反馈「在 DeepSeek 里装不上、装上后 DeepSeek 崩溃」。**本机 DSH `0.2.2-rc.1` 未复现该现象**
> （隔离 profile 安装成功、Host 入口可导入），本节只记录可验证的确定缺陷，不宣称已复现用户的崩溃。

| 编号 | 确定缺陷 | 修复 |
|---|---|---|
| I-01 | `pnpm-lock.yaml` 与 `package.json` 冲突：peer 写 `"*"`，锁文件锁的是 prerelease `0.1.0-rc.6`；干净环境 `pnpm install --frozen-lockfile` 报 `ERR_PNPM_OUTDATED_LOCKFILE`（DSH 安装回滚正是用 `--frozen-lockfile`） | peer 改精确版本 `0.1.0-rc.6` / `3.19.0`，重新生成锁文件 |
| I-02 | 干净 clone 后 `pnpm typecheck` 失败 7 处（缺 `@types/node`） | `devDependencies` 补 `@types/node` |
| I-03 | Client Typert descriptors 只声明 6 个方法，Host 实际有 7 个（缺 `ping`） | 补 `remoteMethod('ping')` |
| I-04 | Client `apply()` 在 `$mount` 失败时 rethrow；DSH Web boot 只要有一个 entry 未激活就整体抛错，单个插件会拖垮整个界面 | 挂载/注册异常降级为「面板缺席 + 写日志」，不再 rethrow |
| I-05 | **「能看到插件但没运行」的真正根因**：Client `$mount` 的 descriptor 把 `parameters[].codec.mode` 写成 `src-json`（那是 Host 侧 SRC 派生的保守标记），而 DSH `validateContribution → requireStrictInputs` 硬性要求 `strict`，带参方法必然抛 `has no strict codec`。旧代码 rethrow → Web boot 整体失败（表现为 DeepSeek 崩）；I-04 降级后 → 面板静默缺席（表现为装上了但没运行） | 按 DSH 官方生成的 descriptor 改为 `codec.mode: 'strict'`（带 passthrough `create`），`result` 同步改 strict；`dist/verify-client.cjs` 复现该校验 |

**端到端验证**（隔离 `DSH_HOME=/tmp/dsh-verify-tgz`，未触碰真实 profile，全部通过）：
`dsh plugin add <tgz>` → `dsh --dump-config` → `dsh --dump-config-schema`（Host 导入）→ `dist/verify-client.cjs <tgz>`（7 个 descriptors / 3 个带参方法 strict 校验、面板注册、失败降级）。
另：`pnpm install --frozen-lockfile` / `pnpm typecheck` / `pnpm build` 均通过；Host 产物保持 14.03 kB，宿主协议包仍为 external。

### 真实 profile 验收（2026-11-10 21:03，用户授权）

- **安装**：`dsh plugin --profile desktop add <dist tgz>` 成功；`package.json` 只新增 1 个依赖 + 1 层 bundle，`cordis.patch.yml` / `cordis.yml` 未被安装改动，未影响其他插件。配置备份在 `dist/backup-20261110-2048/`。
- **重启**：优雅退出旧主进程 `76171` → 新主进程 `95423` + Host `95445`；Host 监听 `127.0.0.1:63162` / `9230`，无系统崩溃报告，`dsh-auth-*` cookie 24→25（远低于触发 431 的 71 条）。冷启动约需 30 秒以上，不是崩溃。
- **修复上线**：重新打包并 `dsh plugin add` 更新，已安装 `lib/client.js` MD5 与新 tgz 完全一致；DSH 刷新/重启后 Code Cache 出现加载本插件 JS 的痕迹。
- **启用状态**：`plugin-operations/operations.jsonl` 记录 21:03:09 `include:hermes-workspace` 被置为 `enabled=true` 且 `applied`。此前该 entry 处于 disabled，是「能看到插件但没运行」的另一层原因。
- **仍未确认 / 阻塞**：Electron 未暴露 AX 辅助功能树，无法自动目视面板；本机 `127.0.0.1:22222` 未监听（Hermes Desktop 侧 SSH 端点未提供），即使面板加载，Gateway 也会 `Connection refused`。需用户在界面确认面板，并恢复该端点。

## 当前状态（现行，2026-11-10 19:38）

- **插件实现完成**：DSH 原生面板 + `GatewayTransport` 直连 Hermes TUI Gateway JSON-RPC，恢复 canonical Bot Chat；`pnpm typecheck` / `pnpm build` 均通过，`lib/` 产物已重建，旧 REST 适配器已清理。
- **协议验证完成**：P0-00 只读组 E0–E5/E7、写入组 E6/E9/E10 通过；E8 数据层证明与 Hermes Desktop 共用同一条会话，16:38 拿到正常模型回复 `PONG-DSH-OK`。B1（远端模型 400）已自愈。详见 [P0-00](docs/P0-00-gateway-validation.md)。
- **宿主环境故障已定位（与插件无关）**：① DSH `0.2.2-rc.1` 的 `dsh-auth-*` cookie 累积到 71 条撑爆 Node 16KB 请求头上限 → 431 → 启动报 `Web authentication failed`，清理历史 cookie 后修复（RC 缺陷，约 70 次启动后会复发）；② 账号 accessToken 过期触发 `session-expired` → `showWelcome()`，导致反复弹回「开始设置」页，需完成登录或配置 API Key。19:02 强制重启成功（Host `127.0.0.1:58208`，无新增崩溃日志）。完整证据、二分诊断与全部踩坑见 **[实验进展与踩坑记录](docs/EXPERIMENT-LOG.md)**。
- **验收待办**：面板已可点、已显示 73 条真实消息；剩余是 E8 的 Desktop 目视（同一会话双向可见）与多 Bot。
- **已知边界**：0.1.4 起为本机直连，不再依赖 `127.0.0.1:22222`；Gateway 端口仍每次 discovery（当前 `55235`），不硬编码。

## 目标（现行，ADR-001）

**在 DSH 里稳定跟 Delores 等多个 Bot 持续聊、保持人格与记忆连续**；多 Bot 管理为后续。实现方式是 DSH 原生面板直连 Hermes TUI Gateway JSON-RPC，恢复 Bot Mode 的 canonical Bot Chat，不另建一套聊天。

> 历史阶段（11-10 中午前）：「侧边栏只做入口，不自建聊天区」。下方「非目标」与「当前状态（历史记录）」属该阶段留痕，已失效条目就地标注。

## 非目标

- 不修改 DSH 核心或 Hermes Runtime
- 不在插件内实现 Agent Loop / Memory / 人格 / 工具执行
- 不在 DSH 主面板 iframe 嵌入 dashboard `/chat`（**设计取舍**，非技术不可能；实测主因是 Gateway listener withhold token 使 `/api/*` 401，不是跨源）
- 不把 API Key / session token 明文放进浏览器或普通配置
- 不接管 Telegram / Discord 等渠道会话
- ~~不由插件管理 SSH 进程~~ **已失效**：插件现在自己拉起并管理 Gateway 隧道；现行边界是「不修改 Hermes Runtime 的配置与数据」
- 不把 8642 API Server 当成官方页面

## 当前状态（历史记录）

> 以下为「只做入口」阶段的记录；现行状态见 [ADR-001](docs/ADR-001-gateway-protocol.md) 与 [P0-00](docs/P0-00-gateway-validation.md)。

- 更新时间：2026-11-10
- 宿主：DSH `0.2.2-rc.1`，profile `desktop`
- 仓库提交：见 `git log`（文档提交会再记一笔）
- 已安装：`plugin_manager install_bundle` → `application: applied`；替换 JS 后需重启 DSH
- 已验证：
  - 左侧 Slot `sidebar.panellist` / `main` occupant `hermes-workspace`
  - SSH dashboard REST：`GET /api/health`、会话列表、历史消息可读（曾在 `http://127.0.0.1:63039` 显示 online / 0.23.0）
  - 本机 SPA dashboard：`http://127.0.0.1:58559/chat` 返回 Hermes Agent Dashboard HTML
  - iframe 嵌入 `/chat` 会停在 `Loading chat…` 并闪烁（已复现，已撤回）
- 未验证：点侧边栏后系统浏览器稳定打开 `/chat` 的完整 TUI 会话（需刷新 DSH 后再测）
- 阻塞：官方 Bot Chat 只能在 Desktop 原生窗口；DSH 不能成为该页面的容器

## 已走过的路径（不要再走回头路）

1. **项目准备**：空目录 → README / git / `.gitignore`
2. **工程骨架**：Host `HermesBridgeService` + Client 侧栏入口，按 V1.0 PRD 的 `8642 /v1/runs`
3. **改接现有 SSH**：用户本机 Hermes Desktop 连远程 `jackdu@127.0.0.1:22222`，本地转发端口会变（59585 → 63039）。REST 能列会话，但那是 **headless `hermes serve`，没有网页 UI**
4. **用户改需求**：侧栏只要进原生 Bot 聊天区，插件不自建 UI
5. **误接 Desktop deeplink** `hermes://open/`：能打开 App，但不是「DSH 容器里显示对话」
6. **误 iframe `58559/chat`**：页面能出来，但 Chat 一直 Loading 并闪烁
7. **现行**：发现本机 dashboard SPA，用系统浏览器打开同源 `/chat`；DSH 面板只说明入口

## 官方对话页与端口

核对来源（2026-11-10）：

- [Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode)
- [Web Dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard)
- [API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- [How to Open the Dashboard](https://hermes-agent.ai/how-to/use-hermes-web-ui)

| 入口 | 官方用途 | 默认端口 | 是不是官方 Bot 对话页 |
|---|---|---|---|
| Hermes Desktop → Bots | 点 Bot 打开 canonical **Bot Chat**（标题必须正好是 `Bot Chat`） | 无固定端口，原生窗口 | **是** |
| `hermes dashboard` → `/chat` | 浏览器嵌 `hermes --tui`（PTY + `/api/pty` WebSocket） | **9119**（本机实测也曾在 **58559**） | 管理端网页 Chat，**不是** Desktop Bot Chat |
| `hermes serve`（Desktop SSH 后端） | headless JSON-RPC / REST，给 Desktop 用 | 动态端口（本机见过 59526 / 59585 / 63039） | **没有网页 UI** |
| API Server | OpenAI 兼容 `/v1`，给 Open WebUI 等 | **8642** | **没有官方页面** |
| Telegram / Discord / CLI | 同一套 Agent 的其他前端 | 各自协议 | 各自原生界面 |

官方约束：

- Dashboard CORS / WebSocket **只认自己的 origin**（绑定端口上的 `127.0.0.1` / `localhost`）。DSH Web GUI 是另一个 origin，iframe 嵌 `/chat` 会被拒。
- `serve` 与 `dashboard` 不要抢同一端口：dashboard 带 SPA，serve 给 Desktop 远程后端。
- 8642 默认 **无 CORS**，浏览器不能当页面用。
- API 会话不能接管 CLI / TUI / Desktop / 渠道已有会话（409 `permission_denied`）。
- 本机实测 SSH 目标：`jackdu@127.0.0.1:22222`，远端 `/Users/jackdu/.local/bin/hermes` v0.23.0，Bot 名 Delores。Desktop 自己维护隧道，插件不创建 SSH。

因此 DSH 侧边栏 **不能** 画出官方 Bot 对话区。能做的只有：打开 Hermes Desktop，或打开 dashboard `/chat` 自己的窗口。

## 本机已观察到的入口

| 时间 | 地址 | 是什么 |
|---|---|---|
| 11:15 | `127.0.0.1:59526` / `59585` | Desktop SSH 转发的 headless serve |
| 13:26 | `127.0.0.1:63039` → 远端 `49703` | 同上，REST 会话列表可用，`/` 返回 web UI disabled |
| 持续 | `127.0.0.1:58559` | 本机 gateway 带 SPA，`/chat` 是 Dashboard HTML |
| 未监听 | `9119`、`8642`、`18642` | 官方默认端口，本机当时没开 |

Token：Desktop SSH 连接的 dashboard token 曾以明文写在 `~/.hermes/gateway-connections.json`。插件若保存，只进 DSH Credentials：`@jackdu/dsh-hermes-workspace/default-api-key`。文档不抄密钥。

## 安装与开发

```bash
pnpm install
pnpm typecheck
pnpm build
mkdir -p dist && pnpm pack --pack-destination dist
```

由 `plugin_manager install_bundle` 安装，不要手改 `~/.dsh/profiles/desktop/package.json`。`lib/index.js` 是 Host，`lib/client.js` 是 Web Client。

- **推荐安装源**：`dist/jackdu-dsh-hermes-workspace-0.1.4.tgz` 的绝对路径（本地 tarball，避开私有 Git 仓库认证问题）；也可直接给项目根目录的绝对路径。
- **DSH 版本闸门**：`engines.dsh = ">=0.2.2-rc.1"` 是唯一裁决项（存在时忽略 peerDependencies）。低于该版本会以 `incompatible-version` 被拒；确需在旧版运行时，用 `dsh plugin allow-version '@jackdu/dsh-hermes-workspace@0.1.0' --dsh-version <version> --accept-risk` 加精确版本豁免后重试。
- **可重复验证**：`node dist/verify-client.cjs dist/jackdu-dsh-hermes-workspace-0.1.0.tgz` 验证 Client 挂载失败时的降级行为。

## 事实源与维护约定

| 信息 | 位置 |
|---|---|
| 目标、范围、非目标、验收 | V1.0 PRD 与「只做入口」均为历史阶段；**现行以 [ADR-001](docs/ADR-001-gateway-protocol.md) 为准** |
| 当前阶段、已验证、阻塞 | 本 README「当前状态（现行）」；协议验证以 [P0-00](docs/P0-00-gateway-validation.md) 为准 |
| 过程证据、全部踩坑、宿主环境故障 | **[实验进展与踩坑记录](docs/EXPERIMENT-LOG.md)** |
| 官方端口与对话页 | 本 README「官方对话页与端口」 |
| 阶段路由 | [PROJECT_WORKFLOW.md](PROJECT_WORKFLOW.md) |

- **接续工作时**：先读本 README 当前状态，再改代码。
- **形成交接时**：更新已验证 / 未验证 / 下一步；聊天结论不能冒充事实源。

不另建 `AGENTS.md`。

## 下一步

> **2026-11-10：本节已被 [ADR-001](docs/ADR-001-gateway-protocol.md) 取代**。改为直连 TUI Gateway JSON-RPC，[P0-00](docs/P0-00-gateway-validation.md) 已执行完毕；**现行待办以 [实验进展与踩坑记录](docs/EXPERIMENT-LOG.md) 第 6 节为准**（面板 UI 目视、E8 Desktop 目视、账号态恢复、多 Bot P1）。以下仅作历史记录。

若仍要「在 DSH 里看见对话」，只能二选一，且都不是官方 Bot Chat 容器：

1. 接受侧栏打开 Hermes Desktop（官方 Bot Chat）
2. 接受侧栏打开本机 dashboard `/chat` 浏览器窗口（官方网页 TUI Chat）

不要再尝试：iframe、8642 当页面、把 headless SSH serve 当成网页对话区。
