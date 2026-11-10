# Hermes Workspace

> **2026-11-10 现行决策**：见 [ADR-001](docs/ADR-001-gateway-protocol.md)——DSH 原生 UI 直连 Hermes TUI Gateway JSON-RPC；[P0-00](docs/P0-00-gateway-validation.md) 已执行完毕，UI 已实施。
> 当前阶段：**Gateway Protocol Adapter 已在 DSH 中运行**；现行状态见下方「当前状态（现行）」，标题带「历史」的段落只作留痕。
> 插件包名：`@jackdu/dsh-hermes-workspace`　面板 ID：`hermes-workspace`　版本：`0.1.0`

## 当前状态（现行，2026-11-10 19:38）

- **插件实现完成**：DSH 原生面板 + `GatewayTransport` 直连 Hermes TUI Gateway JSON-RPC，恢复 canonical Bot Chat；`pnpm typecheck` / `pnpm build` 均通过，`lib/` 产物已重建，旧 REST 适配器已清理。
- **协议验证完成**：P0-00 只读组 E0–E5/E7、写入组 E6/E9/E10 通过；E8 数据层证明与 Hermes Desktop 共用同一条会话，16:38 拿到正常模型回复 `PONG-DSH-OK`。B1（远端模型 400）已自愈。详见 [P0-00](docs/P0-00-gateway-validation.md)。
- **宿主环境故障已定位（与插件无关）**：① DSH `0.2.2-rc.1` 的 `dsh-auth-*` cookie 累积到 71 条撑爆 Node 16KB 请求头上限 → 431 → 启动报 `Web authentication failed`，清理历史 cookie 后修复（RC 缺陷，约 70 次启动后会复发）；② 账号 accessToken 过期触发 `session-expired` → `showWelcome()`，导致反复弹回「开始设置」页，需完成登录或配置 API Key。19:02 强制重启成功（Host `127.0.0.1:58208`，无新增崩溃日志）。完整证据、二分诊断与全部踩坑见 **[实验进展与踩坑记录](docs/EXPERIMENT-LOG.md)**。
- **验收待办**：DSH 面板 UI 目视（UI-01 修复后）、E8 的 Desktop 目视；依赖 DSH 主界面可见、账号态恢复、Hermes Desktop 提供 SSH `127.0.0.1:22222` 端点。
- **已知边界**：SSH 端点 `22222` 由 Hermes Desktop 提供，未运行时插件传输层会 `Connection refused`；Gateway 端口每次 discovery，不可硬编码。

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
pnpm build
```

由 `plugin_manager install_bundle` 安装本目录，不要手改 `~/.dsh/profiles/desktop/package.json`。`lib/index.js` 是 Host，`lib/client.js` 是 Web Client。

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
