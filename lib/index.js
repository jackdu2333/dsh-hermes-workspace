import { randomUUID } from "node:crypto";
import Schema from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { spawn } from "node:child_process";
import net from "node:net";

//#region src/shared/constants.ts
/** 插件包名，与 package.json name 一致。 */
const PACKAGE_NAME = "@jackdu/dsh-hermes-workspace";
/** Loader 行 id / 左侧面板 id / main keyed slot key。 */
const PANEL_ID = "hermes-workspace";
/** Typert Remote namespace，Client 通过 ctx.remote.hermesWorkspace 访问。 */
const REMOTE_NAMESPACE = "hermesWorkspace";

//#endregion
//#region src/host/gatewayRemote.ts
const REMOTE_CMD = [
	"VENV=$(ls -d ~/.hermes/installs/*/environments/*/venv 2>/dev/null | head -1)",
	"PYBIN=\"${VENV:+$VENV/bin/python}\"",
	"if [ -z \"$PYBIN\" ]; then PYBIN=$(ls -d ~/.hermes/tools/python-*/bin/python3 2>/dev/null | head -1); fi",
	"\"$PYBIN\" - <<'PY'",
	`import sys, os, json, types, subprocess
sys.path.insert(0, os.path.expanduser("~/.hermes/hermes-agent"))
os.environ["HERMES_HOME"] = os.path.expanduser("~/.hermes")
from hermes_cli import gateway_client
from hermes_cli.gateway_runtime import gateway_profile_home
from hermes_constants import get_hermes_home
v = json.loads(subprocess.check_output(
    [os.path.expanduser("~/.local/bin/hermes"), "gateway", "ensure", "--json"], text=True, timeout=30))
if v.get("state") != "ready" or not (v.get("endpoint") or {}).get("api_origin"):
    raise SystemExit("gateway not ready: " + str(v.get("reason_code")))
ep_raw = v["endpoint"]
ep = types.SimpleNamespace(**{k: ep_raw.get(k) for k in (
    "api_origin", "authority_epoch", "capabilities", "code_sha", "control_home",
    "instance_id", "profile_id", "runtime_protocol", "supervisor")})
ticket = gateway_client._session_ticket(gateway_profile_home(get_hermes_home()), ep)
url, protocols = gateway_client.gateway_ws_target(ep, ticket)
print(json.dumps({"api_origin": ep.api_origin, "ticket": ticket,
                  "instance_id": ep.instance_id, "profile_id": ep.profile_id, "ws_url": url}))
`,
	"PY"
].join("\n") + "\n";
function sshArgs(target) {
	return [
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=6",
		"-o",
		"StrictHostKeyChecking=no",
		"-p",
		String(target.port),
		`${target.user}@${target.host}`
	];
}
function sshExec(target, command) {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [...sshArgs(target), command], { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.once("error", (error) => reject(error));
		child.once("close", (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error(err.trim() || `ssh 退出码 ${code}`));
		});
	});
}
async function freePort() {
	const server = net.createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise((resolve) => server.close(() => resolve()));
	return port;
}
async function waitTunnel(port) {
	for (let attempt = 0; attempt < 30; attempt++) {
		if (await new Promise((resolve) => {
			const socket = net.connect(port, "127.0.0.1");
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
		})) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}
/** DSH Host 侧的 Gateway Protocol Adapter：SSH 通道 + Node 内置 WebSocket + JSON-RPC。 */
var GatewayTransport = class {
	target;
	ws = null;
	tunnel = null;
	pending = /* @__PURE__ */ new Map();
	events = [];
	seq = 0;
	state = "disconnected";
	lastError;
	info;
	constructor(target) {
		this.target = target;
	}
	get status() {
		return {
			state: this.state,
			instanceId: this.info?.instance_id,
			profileId: this.info?.profile_id,
			apiOrigin: this.info?.api_origin,
			errorMessage: this.lastError,
			checkedAt: Date.now()
		};
	}
	async connect() {
		this.state = "connecting";
		this.release();
		try {
			const line = (await sshExec(this.target, REMOTE_CMD)).split("\n").filter(Boolean).pop();
			if (!line) throw new Error("远端 attach helper 没有返回数据");
			this.info = JSON.parse(line);
			const remotePort = Number(new URL(this.info.api_origin).port);
			const localPort = await freePort();
			const tunnel = spawn("ssh", [
				...sshArgs(this.target),
				"-o",
				"ExitOnForwardFailure=yes",
				"-N",
				"-L",
				`${localPort}:127.0.0.1:${remotePort}`
			], { stdio: "ignore" });
			this.tunnel = tunnel;
			tunnel.once("error", (error) => {
				this.lastError = `SSH 隧道异常: ${error.message}`;
				this.state = "error";
			});
			if (!await waitTunnel(localPort)) throw new Error("SSH 端口转发未就绪");
			const ws = new WebSocket(`ws://127.0.0.1:${localPort}/api/ws`, ["hermes-gateway-v1", `hermes-gateway-ticket.${this.info.ticket}`]);
			this.ws = ws;
			this.bindMessages(ws);
			await new Promise((resolve, reject) => {
				ws.onopen = () => resolve();
				ws.onerror = () => reject(/* @__PURE__ */ new Error("Gateway WebSocket 握手失败"));
			});
			if (ws.protocol !== "hermes-gateway-v1") throw new Error(`Gateway 协议不匹配: ${ws.protocol}`);
			this.state = "online";
			this.lastError = void 0;
		} catch (error) {
			this.state = "error";
			this.lastError = error instanceof Error ? error.message : String(error);
			this.release();
			throw error;
		}
	}
	bindMessages(ws) {
		ws.onmessage = (event) => {
			let frame;
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			const id = frame.id;
			if (typeof id === "number" && this.pending.has(id)) {
				const pending = this.pending.get(id);
				this.pending.delete(id);
				if (frame.error !== void 0) pending.reject(/* @__PURE__ */ new Error(`Gateway RPC 错误: ${JSON.stringify(frame.error).slice(0, 200)}`));
				else pending.resolve(frame.result ?? {});
				return;
			}
			if (frame.method === "event") {
				const params = frame.params ?? {};
				this.events.push(params);
				if (this.events.length > 500) this.events = this.events.slice(-500);
				return;
			}
			if (frame.method !== void 0 && id !== void 0) {
				const method = String(frame.method);
				this.events.push({
					type: "unsupported_request",
					detail: `${method} 已被 DSH 明确拒绝（P0 未实现交互审批）`,
					method,
					requestId: id
				});
				if (this.events.length > 500) this.events = this.events.slice(-500);
				try {
					ws.send(JSON.stringify({
						jsonrpc: "2.0",
						id,
						error: {
							code: -32e3,
							message: `DSH client does not support request: ${method}`
						}
					}));
				} catch {}
			}
		};
		ws.onclose = () => {
			if (this.ws === ws) {
				this.state = "disconnected";
				this.ws = null;
				this.rejectPending(/* @__PURE__ */ new Error("Gateway 连接已断开"));
				this.releaseTunnel();
			}
		};
	}
	rejectPending(error) {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
	releaseTunnel() {
		if (this.tunnel) {
			this.tunnel.kill();
			this.tunnel = null;
		}
	}
	release() {
		const ws = this.ws;
		this.ws = null;
		if (ws && ws.readyState === WebSocket.OPEN) ws.close();
		this.rejectPending(/* @__PURE__ */ new Error("Gateway 连接已重置"));
		this.releaseTunnel();
	}
	async ensureOpen() {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
		await this.connect();
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error(this.lastError ?? "Gateway 未连接");
		return this.ws;
	}
	async rpc(method, params = {}) {
		const ws = await this.ensureOpen();
		const id = ++this.seq;
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) reject(/* @__PURE__ */ new Error(`Gateway RPC 超时: ${method}`));
			}, 15e3);
			const finish = () => clearTimeout(timer);
			this.pending.set(id, {
				resolve: (value) => {
					finish();
					resolve(value);
				},
				reject: (error) => {
					finish();
					reject(error);
				}
			});
			try {
				ws.send(JSON.stringify({
					jsonrpc: "2.0",
					id,
					method,
					params
				}));
			} catch (error) {
				finish();
				this.pending.delete(id);
				reject(error);
			}
		});
	}
	drainEvents() {
		const drained = this.events;
		this.events = [];
		return drained;
	}
	close() {
		this.release();
		this.state = "disconnected";
	}
};

//#endregion
//#region src/host/HermesBridgeService.ts
const Config = Schema.object({
	sshHost: Schema.string().default("127.0.0.1").description("Hermes 所在机器的 SSH 地址"),
	sshPort: Schema.number().default(22222).description("Hermes 所在机器的 SSH 端口"),
	sshUser: Schema.string().default("jackdu").description("运行 Hermes 的系统用户")
});
/** 把 Gateway 的 content（字符串或结构化 parts）收敛成展示文本。 */
function extractText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => {
		if (typeof part === "string") return part;
		if (part && typeof part === "object" && "text" in part) return String(part.text ?? "");
		return "";
	}).filter(Boolean).join("\n");
	return "";
}
var HermesBridgeService = class extends TypertRemoteService {
	static inject = [];
	static Config = Config;
	transport;
	constructor(ctx, config = {}) {
		super(ctx, REMOTE_NAMESPACE);
		this.transport = new GatewayTransport({
			host: typeof config.sshHost === "string" && config.sshHost ? config.sshHost : "127.0.0.1",
			port: typeof config.sshPort === "number" ? config.sshPort : 22222,
			user: typeof config.sshUser === "string" && config.sshUser ? config.sshUser : "jackdu"
		});
		ctx.logger?.info?.("hermes-workspace: gateway bridge started");
		this.transport.connect().catch((error) => {
			ctx.logger?.warn?.("hermes-workspace: initial gateway connect failed: %o", error);
		});
		ctx.effect(() => () => {
			this.transport.close();
			ctx.logger?.info?.("hermes-workspace: gateway bridge disposed");
		}, "hermes-workspace: dispose");
	}
	async ping() {
		return {
			ok: true,
			plugin: PACKAGE_NAME,
			panelId: PANEL_ID,
			at: Date.now()
		};
	}
	async getConnectionStatus() {
		return this.transport.status;
	}
	async getBotRoster() {
		const raw = await this.transport.rpc("profiles.list", { include_sessions: true });
		return {
			profiles: (raw.profiles ?? []).map((row) => ({
				name: String(row.name ?? ""),
				displayName: String(row.display_name ?? row.name ?? ""),
				isDefault: Boolean(row.is_default),
				model: String(row.model ?? ""),
				description: String(row.description ?? ""),
				canonicalSessionId: row.canonical_session?.id ? String(row.canonical_session.id) : void 0
			})),
			botModeProtocol: Boolean(raw.bot_mode_protocol)
		};
	}
	async resumeSession(request) {
		const sessionId = request.sessionId.trim();
		if (!sessionId) throw new Error("缺少 sessionId");
		const raw = await this.transport.rpc("session.resume", {
			session_id: sessionId,
			defer_history: true
		});
		const messages = (raw.messages ?? []).map((row, index) => ({
			id: String(row.message_uid ?? row.row_id ?? index),
			role: String(row.role ?? "unknown"),
			text: extractText(row.content),
			timestamp: row.timestamp == null ? void 0 : String(row.timestamp)
		}));
		return {
			sessionId: String(raw.session_id ?? sessionId),
			messages,
			messageCount: typeof raw.message_count === "number" ? raw.message_count : messages.length,
			running: Boolean(raw.running),
			openRequests: raw.open_requests ?? [],
			subscriptionId: raw.subscription_id == null ? void 0 : String(raw.subscription_id),
			executionGeneration: typeof raw.execution_generation === "number" ? raw.execution_generation : void 0
		};
	}
	/** 写入操作：仅在用户点击发送时调用，插件启动与恢复会话都不会自动发消息。
	*  Gateway 的 admission gate 要求每次提交带唯一的 submission_id（官方 Desktop 同样自动补 UUID）。 */
	async submitPrompt(request) {
		const sessionId = request.sessionId.trim();
		const text = request.text.trim();
		if (!sessionId || !text) return {
			accepted: false,
			errorMessage: "会话或消息为空"
		};
		try {
			await this.transport.rpc("prompt.submit", {
				session_id: sessionId,
				text,
				submission_id: randomUUID()
			});
			return { accepted: true };
		} catch (error) {
			return {
				accepted: false,
				errorMessage: error instanceof Error ? error.message : String(error)
			};
		}
	}
	/** 写入操作：仅在用户点击中断时调用。execution_generation 由 session.resume 返回，
	*  不回传会被 Gateway 判为 stale_generation 并拒绝。 */
	async interruptSession(request) {
		const sessionId = request.sessionId.trim();
		if (!sessionId) return {
			accepted: false,
			errorMessage: "缺少 sessionId"
		};
		if (typeof request.executionGeneration !== "number") return {
			accepted: false,
			errorMessage: "缺少执行代次，请先恢复会话"
		};
		try {
			await this.transport.rpc("session.interrupt", {
				session_id: sessionId,
				execution_generation: request.executionGeneration
			});
			return { accepted: true };
		} catch (error) {
			return {
				accepted: false,
				errorMessage: error instanceof Error ? error.message : String(error)
			};
		}
	}
	async getEvents() {
		return { events: this.transport.drainEvents() };
	}
};
const prototype = HermesBridgeService.prototype;
for (const name of [
	"ping",
	"getConnectionStatus",
	"getBotRoster",
	"resumeSession",
	"submitPrompt",
	"interruptSession",
	"getEvents"
]) Remote(name)(prototype[name], {
	name,
	private: false,
	static: false,
	addInitializer(fn) {
		fn.call(Object.create(prototype));
	}
});

//#endregion
export { Config, HermesBridgeService, HermesBridgeService as default };