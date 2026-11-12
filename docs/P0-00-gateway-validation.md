# P0-00 Gateway 协议最小验证（已执行）

> 面向执行者：本任务书已由 WorkBuddy 直接执行完毕（2026-11-10），本文保留为协议事实源。
> 状态：**只读组 E0–E5/E7、写入组 E6/E9/E10 全部通过；E8 已在协议层拿到正常模型回复 `PONG-DSH-OK`**，剩余仅 DSH 面板 UI 与 Desktop 目视验收。
> B1（远端模型 400）**已于 16:38 自愈**，见第 6 节；面板带参 Remote 调用缺陷 UI-01 已修、待刷新验收，见第 7 节。
> 事实源：[ADR-001](ADR-001-gateway-protocol.md)；宿主环境故障、二分诊断与全部踩坑见 [实验进展与踩坑记录](EXPERIMENT-LOG.md)

## 0. 目标与边界

证明：DSH 侧能从 SSH 远端连到 Hermes Gateway，恢复**同一条** canonical Bot Chat 并双向收发；不是另建一套聊天。

**不做**：不修改 Hermes 配置 / 代码 / 数据；不打印 ticket、token、密钥；不把 Dashboard `/chat` 当 Gateway WS；写入组之外不新建会话、不发消息。

## 1. 环境（已实测）

| 项 | 值 |
|---|---|
| SSH | `ssh -o BatchMode=yes -o ConnectTimeout=6 -p 22222 <user>@127.0.0.1 '<cmd>'`（免密可用） |
| 远端 Hermes | v0.23.0，`~/.local/bin/hermes`，`HERMES_HOME=~/.hermes` |
| Python | **必须用** `~/.hermes/tools/python-3.14.*/bin/python3`；系统 `python3` 会在 `gateway/session_contract.py` 报 `TypeError: unsupported operand type(s) for \|` |
| Gateway endpoint | 每次执行 `hermes gateway ensure --json` 取 `endpoint.api_origin`（本次 `http://127.0.0.1:55015`），**不硬编码** |
| canonical Bot Chat | `state.db` 的 `sessions.title='Bot Chat'` → 本次 `local-b29ce87dfe6b7cd985834af1d6858913e138a85d711bb7f2dfc876d2dc22bb6f`（运行时复核） |
| Bot 标记 | 根 `~/.hermes/profile.yaml` 的 `ui_meta.hermes-bots`，`title: Bot A` |
| 协议 | `/api/ws`；subprotocols `["hermes-gateway-v1", "hermes-gateway-ticket.<ticket>"]` |

> WorkBuddy Bash 沙箱看到的 `~/.hermes` 是另一套副本（v0.23.1 / 58559），**不是**本任务的目标环境。
> `55015` 上 `/chat`（Dashboard SPA）与 `/api/ws`（Gateway）共存，但路径与认证机制不同，不要混用。

## 2. 验收项

### 只读组（可直接执行，不改变会话内容）

| ID | 测试 | 通过标准 |
|---|---|---|
| E0 | 远端 ticket 入口探测 | **已完成**，见第 3 节 |
| E1 | SSH 端口转发把远端 `api_origin` 映到本机回环 | 本机 `curl <forward>/api/health` 返回 `ok:true` |
| E2 | Gateway WS 握手 | 升级 101，且 `Sec-WebSocket-Protocol` 回显 `hermes-gateway-v1` |
| E3 | `runtime.describe` | 返回 runtime / protocol / capabilities，与 discovery 的 `code_sha` 一致 |
| E4 | `profiles.list` | 返回 roster 且含 `canonical_session`；与 `state.db` 的 `title='Bot Chat'` 行一致 |
| E5 | `session.resume` | 用 E4 的 canonical session id 恢复成功，返回历史事件 / `open_requests` |
| E7 | 事件订阅 | 收到可解析类型的事件帧，且不产生新会话 |

**只读组实测结果（2026-11-10）**

```text
E1 discovery state=ready api_origin=http://127.0.0.1:55015；SSH 本地端口转发通过
E2 WS handshake OK, subprotocol=hermes-gateway-v1
E3 runtime.describe keys: instance_id / profile_id / authority_epoch / capabilities / session_create / skin
E4 profiles=1 bot_mode_protocol=true canonical=local-b29ce87d…dc22bb6f（与 state.db 一致）
E5 session.resume(defer_history=true) 返回 14 条 messages、open_requests=[]、running=false
E7 events: gateway.ready / platforms.changed
```

- 两条实现都通过：远端 Python（官方 `connect_gateway`）与**本机 Node 内置 WebSocket + SSH 端口转发**；后者即插件实际链路，不依赖任何 npm 包。
- 最终 `src/host/gatewayRemote.ts` 经真实 smoke test：`connect: online` → `profiles: 1 / bot_mode_protocol: true` → `resume: 14 messages` → 事件 `gateway.ready`。
- 两个坑：远端必须用 Hermes venv Python（`~/.hermes/installs/*/environments/*/venv/bin/python`；系统 `python3` 语法过旧且缺 `websockets`）；`session.resume` 的 `lazy=true` 返回 `invalid_params`，须用 `defer_history=true`。

### 写入组（**需要用户单独授权**；会真的写进 Bot A 的 Bot Chat）

| ID | 测试 | 通过标准 |
|---|---|---|
| E6 | `prompt.submit` 发一条可识别的测试消息 | Gateway 接受并产生 assistant 回复事件 |
| E8 | **双端一致性（最高验收项）** | DSH 发出的消息出现在 Hermes Desktop 同一条 Bot Chat；Desktop 发出的消息也能被 DSH 看见。需用户配合观察 Desktop |
| E9 | `session.interrupt` 中断执行中的任务 | 任务停止，会话保持可恢复 |
| E10 | 断线恢复 | 重新 discovery + mint ticket 后 `session.resume` 回到原 session id，历史不丢 |

**写入组实测结果（2026-11-10 16:05–16:22，用户已授权「继续测试」）**

| ID | 结果 | 证据 |
|---|---|---|
| E6 | 通过（修正一次参数后） | 首次 `prompt.submit` 因缺 `submission_id` 返回 `4001 invalid_params`（36ms，**未写入会话**）；补 UUID 后返回 `{"admission_id":…,"status":"queued","sequence":3}`，测试消息在 durable history 可见 |
| E7 | 通过 | 提交后收到 `session.info` ×2 / `message.start` / `agent.step` / `thinking.delta` / `sessions.changed` |
| E8 | **协议层通过** | DSH 与 Desktop 共用同一条 canonical session（`state.db` 同一 `session_id`）；16:38 二次验证 `message_count` 20→22、**6 秒内收到 `PONG-DSH-OK` 正常模型回复**，事件流含 `message.delta / session.usage / message.complete`。**Desktop 目视与 DSH 面板 UI 仍待验收**（见第 7 节 UI-01） |
| E9 | 通过（契约层） | 缺 `execution_generation` 返回 `stale_generation`；回传 `session.resume` 给的代次 `1` 后返回正常 handle。**未制造长任务，「中断运行中任务」未实测** |
| E10 | 通过 | `close()` → 重新 discovery + mint → `connect()` → `session.resume` 回到同一 session id，历史 20 条不丢 |

**写入 RPC 的参数契约（源码实证，必须遵守）**

- `prompt.submit`：`gateway/session_controls.py:submission()` 要求非空 `submission_id`（或 `input_id`），且参数有严格白名单；官方 Desktop 在 `apps/desktop/src/api/canonical-protocol.ts:226` 自动补 UUID。
- `session.interrupt` / `redirect` / `steer`：必须回传 `execution_generation`，由 `session.resume` 返回（`canonical-protocol.ts:426`）。
- Gateway 主动发起的 `approval` / `clarify` 等带 id 请求：DSH P0 明确回 `-32000` 拒绝并推 `unsupported_request` 事件，不让 Agent 无限等待。

**E8 未通过则整个方案不成立，不得进入 UI 开发。** → 数据层与正常对话均已成立，UI 已实施；剩余验收是 Desktop 目视与 UI-01 面板刷新（第 7 节）。

## 3. E0 已完成：可复用的只读探测片段

在远端执行（ticket 值脱敏，**不建立 WS 连接**）：

```bash
PYBIN=$(ls -d ~/.hermes/tools/python-*/bin/python3 | head -1)
"$PYBIN" - <<'PY'
import sys, os, json, types, subprocess
root = os.path.expanduser("~/.hermes/hermes-agent")
sys.path.insert(0, root)
os.environ["HERMES_HOME"] = os.path.expanduser("~/.hermes")
from hermes_cli import gateway_client
from hermes_cli.gateway_runtime import gateway_profile_home
from hermes_constants import get_hermes_home

raw = subprocess.run([os.path.expanduser("~/.local/bin/hermes"), "gateway", "ensure", "--json"],
                     capture_output=True, text=True, timeout=30)
verdict = json.loads(raw.stdout)
ep_raw = verdict["endpoint"]                      # credential-free discovery
ep = types.SimpleNamespace(**{k: ep_raw.get(k) for k in (
    "api_origin", "authority_epoch", "capabilities", "code_sha", "control_home",
    "instance_id", "profile_id", "runtime_protocol", "supervisor")})
home = gateway_profile_home(get_hermes_home())
ticket = gateway_client._session_ticket(home, ep)  # 一次性，30s 过期
url, protocols = gateway_client.gateway_ws_target(ep, ticket)
print("discovery state=", verdict["state"], "api_origin=", ep.api_origin)
print("ticket_minted=", bool(ticket), "ticket_len=", len(ticket))
print("ws_url=", url)
print("subprotocols=", [protocols[0], protocols[1].split(".")[0] + ".<redacted>"])
print("profile_id=", ep.profile_id, "instance_id=", ep.instance_id)
# 故意不 dial WS；ticket 未使用即过期
PY
```

实测输出（2026-11-10）：

```text
discovery state= ready api_origin= http://127.0.0.1:55015
capabilities= ['durable-admission-v1', 'event-replay-v1', 'session-authority-v1']
ticket_minted= True ticket_len= 43
ws_url= ws://127.0.0.1:55015/api/ws
subprotocols= ['hermes-gateway-v1', 'hermes-gateway-ticket.<redacted>']
profile_id= ~/.hermes instance_id=<redacted>
```

结论：**v0.23.0 不需要升级也能拿到 ticket**；缺的只是 `gateway attach` 这个 CLI 包装。

## 4. 实现提示

- `hermes_cli/gateway_client.py:connect_gateway(endpoint=...)` 已封装 discovery → ticket → dial → `GatewayClient`；基于它做最小客户端前，先确认它会 dial WS（写入组才允许）。
- 协议帧目录：`tui_gateway/server.py:195-200`；事件与 `open_requests`：`tui_gateway/server_requests.py`。
- 审批 / 澄清请求：P0 至少显式响应或明确拒绝；不支持的请求不要让 Agent 无限等待。
- ticket 30 秒过期、单次使用、绑定 instance/profile；每次重连重新 discovery + mint。
- owner/viewer 语义见 `tui_gateway/owner_forward.py`；E8 要特别验证非 owner 的 `prompt.submit` 是否被转发给 Desktop 这个 owner。

## 5. 交付物

1. 每个 E 项的命令、响应结构（凭证脱敏）、通过 / 失败结论。
2. E8 的双向证据（时间 + 消息标识）。
3. 失败项的最小复现与剩余风险。
4. 是否建议进入插件 UI 开发的明确结论：**协议侧可以，UI 已实施**；剩余为 Desktop 目视 + B1。

## 6. B1：远端 Agent 执行侧 400（瞬时故障，已自愈）

> **状态：2026-11-10 16:38 二次验证恢复正常，无需改动任何 Hermes 配置。**

- **历史现象（16:13–16:18）**：所有新提交的 user 消息约 1 秒后得到 assistant 行 `Your request was not processed. Send it again if you still want me to carry it out.`（`agent/turn_failure_copy.py:56 FAILED_TURN_NOTICE` —— 失败 turn 的兜底收尾行，**不是模型回复**）。
- **时间线**：16:13:07 / 16:13:50 用户两条真实指令 → 16:13:08 / 16:13:51 `ERROR agent.conversation_loop: Non-retryable client error: Error code: 400 - {'detail': 'Bad Request'}`；16:18:48 首条 E8 测试消息 → 16:18:49 同样的 FAILED_TURN_NOTICE。
- **当时归因**：远端 `https://chatgpt.com/backend-api/codex`（`gpt-6-luna` / `openai-codex` / `reasoning_effort: ultra`）返回 400。Gateway **收消息、写 durable history、事件回流都正常**，只是 turn 跑不出模型回复；不是 DSH 的传输或参数问题，也不是测试误触中断。
- **旁证**：`agent.log` 显示 16:28:19 / 16:29:45 同一 provider 的 API 调用已成功（31.8s / 81.6s），说明是瞬时故障而非配置错误。
- **二次验证（16:38，已解除）**：向同一 canonical session 发 `[DSH P0-00 E8-B]…`，`prompt.submit` 返回 `status=queued / sequence=4`，**6 秒内收到 `PONG-DSH-OK`**，`message_count` 20→22，事件流 `session.info / message.start / agent.step / thinking.delta / message.delta / session.usage / message.complete` 完整，`IS_FAILED_TURN_NOTICE=false`。
- **结论**：E8 的「正常对话效果」已在协议层达成；用户 16:13 那两条指令若仍需执行，可直接在 Desktop 重发。**本次未改动任何 Hermes 配置或数据。**

## 7. UI-01：DSH 面板带参 Remote 调用失败（已修复，待刷新验收）

- **现象（16:36 截图）**：重启后 Hermes 面板「已连接」✅、Bot 列表 `default · 可恢复会话` ✅、事件流 `platforms.changed / skills.changed` ✅，但**会话历史 0 条**，顶部红字 `Failed to execute 'any' on 'AbortSignal': Failed to convert value to 'AbortSignal'.`。
- **根因**：`src/client/index.tsx` 的 `$mount` descriptor 手写 `parameters: []` + `cancellation: { parameter: 'signal' }`，与 Host 侧 SRC 从方法签名派生的 descriptor 不一致。运行时 `expected = descriptor.parameters.length = 0`，`hasCallerSignal = cancellation 存在 && values.length === expected + 1`，于是 `resumeSession(request)` 的**唯一实参被当作 callerSignal** 传进 `AbortSignal.any([token.abort.signal, request])` 而抛错；无参方法（`getBotRoster` / `getConnectionStatus` / `getEvents`）因 `values.length=0` 恰好不受影响。
- **依据**：DSH `app.asar` 内 `prepareInvocation`（`336404–336425`）、`assertExactArguments` / `validateArguments`（`339661–339679`）、SRC descriptor 派生（`339270–339300`：形参名即 `wire`、`codec:{mode:'src-json'}`、**仅当 Host 方法末位形参为 `signal` 才生成 cancellation**）。
- **修复**：带参方法声明 `parameters: [{ name:'request', wire:'request', source:'json', codec:{mode:'src-json'} }]`，**去掉 `cancellation`**；`HermesRemote` 类型同步去掉 `signal`，删除未使用的 `jsonCodec`。`pnpm typecheck` / `pnpm build` 通过。
- **待验收**：本轮**只改 Client**，DSH renderer 需刷新窗口（Cmd+R）或重启才会重新 `$mount`。刷新后预期：面板显示 **22 条历史**、无红字、发送与中断可用。未刷新前面板仍是旧 descriptor。
