# Hermes Workspace

> 当前阶段：**接入现有 Hermes Desktop SSH dashboard**
> 插件包名：`@jackdu/dsh-hermes-workspace`　面板 ID：`hermes-workspace`

DSH 原生双端插件：在左侧功能栏提供独立 Hermes 工作区，连接本机或经 SSH 隧道访问的 Hermes Agent API。插件不实现 Agent 能力，只负责连接、消息转换、状态呈现和交互控制。

## 第一阶段目标

P0 可用版本：用户能从 DSH 左侧进入 Hermes 工作区，配置连接，创建/恢复 Hermes 会话，发送消息并看到流式输出、工具状态，并能中断任务。

## 非目标（P0）

- 不修改 DSH 核心或 Hermes Runtime
- 不在插件内实现 Agent Loop / Memory / 人格复制
- 不把 Hermes 工具转换成 DSH 工具再执行
- 不把 API Key 明文放进浏览器、localStorage 或普通配置
- 不接管 Telegram / Discord 等渠道会话
- 不由插件管理 SSH 进程

## 当前状态

- 更新时间：2026-11-10
- 适用版本：`@jackdu/dsh-hermes-workspace@0.1.0`，宿主 DSH `0.2.2-rc.1`，profile `desktop`
- 当前阶段：对接 Hermes Desktop SSH dashboard `/api`
- 已完成：Credentials 保存 URL/token、自动发现仍存活的本机转发端口、会话列表、历史消息
- 未验证：`127.0.0.1:22222` 关闭时只能显示 offline，需 Desktop 重新连上后再测在线
- 不做：插件不管理 SSH；不接 `/v1/runs`；发送与流式输出下一刀再做

## 架构边界

| 层 | 职责 |
|---|---|
| DSH Client | 工作区 UI；不得直连 Hermes API |
| DSH Host | HTTP、凭据、SSE 解析、Remote 暴露 |
| Hermes Runtime | Agent、人格、Memory、Skills、Tools、会话持久化 |

会话与执行状态的唯一事实来源是 Hermes，不是 DSH Session。

## 安装

在当前 DSH profile 中安装本目录：

```bash
# 由 Agent / plugin_manager 执行 install_bundle，target 为本仓库绝对路径
# 不要手改 ~/.dsh/profiles/<profile>/package.json 或 cordis.patch.yml
```

开发时先构建 Client/Host 产物：

```bash
pnpm install
pnpm build
```

`lib/index.js` 是 Host 入口，`lib/client.js` 是 Web Client 入口。替换已安装包后需要重启 DSH 才能加载新的 JS 模块。

## 连接（现有 Desktop SSH dashboard）

本机 Hermes Desktop 已保存 SSH 连接：`jackdu@127.0.0.1:22222`，远端 `/Users/jackdu/.local/bin/hermes`。Desktop 会把远端 dashboard 转发到 **本机动态端口**（曾经是 `59585`，每次重连会变）。

在工作区填写：

1. Dashboard URL：`http://127.0.0.1:<Desktop 当前转发端口>`
2. Session token：Hermes Desktop 该 SSH 连接的 dashboard token（Host 写入 DSH Credentials，记录 id `@jackdu/dsh-hermes-workspace/default-api-key`）
3. Profile：默认 `default`

探测：`GET /api/health`（可无 token）→ `GET /api/auth/me` / `GET /api/sessions`（需要 `X-Hermes-Session-Token` 或 `Authorization: Bearer`）。

插件不创建 SSH 隧道。Desktop 未连接时状态为 `offline`。

## 事实源与维护约定

| 信息 | 位置 |
|---|---|
| 目标、范围、非目标、验收 | 本 README；完整规格见用户提供的 V1.0 PRD |
| 当前阶段、阻塞、下一步 | 本 README「当前状态」 |
| 阶段路由 | [PROJECT_WORKFLOW.md](PROJECT_WORKFLOW.md)；开始新阶段或接续工作时先按该文件定位当前任务与事实源 |
| 重大决策 | README 架构边界；出现持久取舍时再建 ADR |
| 验证证据 | 安装结果与 Slot 检查记录在当轮交接中 |

- **接续工作时**：先读本 README 当前状态和 PROJECT_WORKFLOW，再改代码。
- **形成交接时**：更新当前阶段、已验证/未验证和下一步；不要把聊天结论当成事实源。

不另建 `AGENTS.md`：沿用全局 DSH / Codex 规则。

## 下一步

1. Desktop 连上 SSH 后，在工作区填入当前转发 URL 和 token，确认会话列表。
2. 发送消息：优先 `POST /api/sessions/{id}/chat` 或 Desktop WS；现有 OpenAPI 没有 `/v1/runs`。
3. 流式输出另开一刀。
