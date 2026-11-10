# Hermes Workspace

> 当前阶段：**DSH 侧边栏只做 Hermes 入口，不在 DSH 内渲染官方 Bot 对话页**
> 插件包名：`@jackdu/dsh-hermes-workspace`　面板 ID：`hermes-workspace`　版本：`0.1.0`

DeepSeek Harness 原生双端插件。左侧功能栏提供 Hermes 入口。Hermes Agent 是后台运行时；官方对话页在 Hermes Desktop 或 `hermes dashboard`，不在 DSH 里重做。

## 目标（现行）

用户从 DSH 左侧点 Hermes，进入官方 Hermes 对话面：优先打开本机已运行的 `hermes dashboard` `/chat`；没有 dashboard 时打开 Hermes Desktop。插件不实现 Agent 能力。

用户后来明确：**侧边栏只是入口，里面不需要自己开发聊天区。**

## 非目标

- 不修改 DSH 核心或 Hermes Runtime
- 不在插件内实现 Agent Loop / Memory / 人格 / 工具执行
- 不在 DSH 主面板 iframe 嵌入 dashboard `/chat`（跨源会卡住 Loading chat）
- 不把 API Key / session token 明文放进浏览器或普通配置
- 不接管 Telegram / Discord 等渠道会话
- 不由插件管理 SSH 进程
- 不把 8642 API Server 当成官方页面

## 当前状态

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
| 目标、范围、非目标、验收 | 本 README。V1.0 PRD 是早期双端聊天工作区规格，**已被「只做入口」覆盖** |
| 当前阶段、已验证、阻塞 | 本 README「当前状态」 |
| 官方端口与对话页 | 本 README「官方对话页与端口」 |
| 阶段路由 | [PROJECT_WORKFLOW.md](PROJECT_WORKFLOW.md) |

- **接续工作时**：先读本 README 当前状态，再改代码。
- **形成交接时**：更新已验证 / 未验证 / 下一步；聊天结论不能冒充事实源。

不另建 `AGENTS.md`。

## 下一步

若仍要「在 DSH 里看见对话」，只能二选一，且都不是官方 Bot Chat 容器：

1. 接受侧栏打开 Hermes Desktop（官方 Bot Chat）
2. 接受侧栏打开本机 dashboard `/chat` 浏览器窗口（官方网页 TUI Chat）

不要再尝试：iframe、8642 当页面、把 headless SSH serve 当成网页对话区。
