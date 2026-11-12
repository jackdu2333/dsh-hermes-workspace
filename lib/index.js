import { randomBytes, randomUUID } from "node:crypto";
import Schema from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

//#region src/shared/constants.ts
/** 插件包名，与 package.json name 一致。 */
const PACKAGE_NAME = "@jackdu/dsh-hermes-workspace";
/** Loader 行 id / 左侧面板 id / main keyed slot key。 */
const PANEL_ID = "hermes-workspace";
/** Typert Remote namespace，Client 通过 ctx.remote.hermesWorkspace 访问。 */
const REMOTE_NAMESPACE = "hermesWorkspace";

//#endregion
//#region src/host/gatewayRemote.ts
/** 本机 Hermes 自带 python 的定位顺序：venv → tools 下的解释器。 */
const LOCAL_CMD = [
	"VENV=$(ls -d ~/.hermes/installs/*/environments/*/venv 2>/dev/null | head -1)",
	"PYBIN=\"${VENV:+$VENV/bin/python}\"",
	"if [ -z \"$PYBIN\" ]; then PYBIN=$(ls -d ~/.hermes/tools/python-*/bin/python3 2>/dev/null | head -1); fi",
	"if [ -z \"$PYBIN\" ]; then echo \"未找到 Hermes 自带的 python 解释器\" >&2; exit 1; fi",
	"export HERMES_HOME=\"${HERMES_HOME:-$HOME/.hermes}\"",
	"export PYTHONPATH=\"$HERMES_HOME/hermes-agent${PYTHONPATH:+:$PYTHONPATH}\"",
	"\"$PYBIN\" - <<'PY'",
	`import sys, os, json, types, subprocess
sys.path.insert(0, os.path.expanduser("~/.hermes/hermes-agent"))
os.environ["HERMES_HOME"] = os.path.expanduser("~/.hermes")
from hermes_cli import gateway_client
from hermes_cli.gateway_runtime import gateway_profile_home
from hermes_constants import get_hermes_home
profile = os.environ.get("HERMES_DSH_PROFILE") or "default"
v = json.loads(subprocess.check_output(
    [sys.executable, "-m", "hermes_cli.main", "--profile", profile, "gateway", "ensure", "--json"],
    text=True, timeout=30, stderr=subprocess.DEVNULL))
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
function localExec(command, env) {
	return new Promise((resolve, reject) => {
		const child = spawn("bash", ["-lc", command], {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			env
		});
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
			else reject(new Error(err.trim().split("\n").pop() || `本地 helper 退出码 ${code}`));
		});
	});
}
/** DSH Host 侧的 Gateway Protocol Adapter：本机直连 + Node 内置 WebSocket + JSON-RPC。 */
var GatewayTransport = class {
	target;
	ws = null;
	pending = /* @__PURE__ */ new Map();
	events = [];
	/** 还等着用户决定的交互请求。面板每轮轮询取全量，用户点了才回包。 */
	requests = [];
	/** 快照读取期间仍会收到实时撤回；保留变更版本，避免迟到快照复活失效卡片。 */
	requestVersion = 0;
	requestUpdates = /* @__PURE__ */ new Map();
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
	connecting;
	lastAttemptAt = 0;
	/** Hermes gateway 每次重启都会换端口（`gateway ensure` 返回新地址），
	*  连接断了以后必须能自己恢复，否则面板会一直停在「连接失败」、
	*  只能靠重启整个 DSH 才能好。这里做节流的自动重连：
	*  - 已在线或正在连：直接复用；
	*  - 两次尝试之间至少间隔 minIntervalMs，避免面板 1.5s 轮询打爆 helper 进程。 */
	ensureConnected(minIntervalMs = 4e3) {
		if (this.state === "online") return void 0;
		if (this.connecting) return this.connecting;
		const now = Date.now();
		if (now - this.lastAttemptAt < minIntervalMs) return void 0;
		this.lastAttemptAt = now;
		this.connecting = this.connect().catch(() => void 0).finally(() => {
			this.connecting = void 0;
		});
		return this.connecting;
	}
	async connect() {
		this.state = "connecting";
		this.release();
		try {
			const line = (await localExec(LOCAL_CMD, {
				...process.env,
				HERMES_DSH_PROFILE: this.target.profile
			})).split("\n").filter(Boolean).pop();
			if (!line) throw new Error("本机 attach helper 没有返回数据");
			this.info = JSON.parse(line);
			if (!this.info.ws_url) throw new Error("未获取到 Gateway WebSocket 地址");
			const ws = new WebSocket(this.info.ws_url, ["hermes-gateway-v1", `hermes-gateway-ticket.${this.info.ticket}`]);
			this.ws = ws;
			this.bindMessages(ws);
			await new Promise((resolve, reject) => {
				ws.onopen = () => resolve();
				ws.onerror = () => reject(/* @__PURE__ */ new Error(`Gateway WebSocket 握手失败（${this.info?.ws_url}）`));
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
			if (typeof id === "number" && frame.method === void 0 && this.pending.has(id)) {
				const pending = this.pending.get(id);
				this.pending.delete(id);
				if (frame.error !== void 0) pending.reject(/* @__PURE__ */ new Error(`Gateway RPC 错误: ${JSON.stringify(frame.error).slice(0, 200)}`));
				else pending.resolve(frame.result ?? {});
				if (this.pending.size === 0) this.requestUpdates.clear();
				return;
			}
			if (frame.method === "event") {
				const params = frame.params ?? {};
				const payload = params.payload ?? {};
				const sessionId = params.session_id ?? params.sessionId;
				if (params.type === "request.cancel") {
					const cancelled = String(payload.id ?? "");
					this.removeRequests((item) => String(item.id) === cancelled && (!sessionId || item.sessionId === sessionId));
					this.requestUpdates.set(JSON.stringify([
						"rpc",
						sessionId,
						payload.id
					]), ++this.requestVersion);
				} else if (params.type === "approval.request" || params.type === "clarify.request") {
					const request = this.canonicalRequest({
						...payload,
						kind: params.type.split(".")[0]
					}, sessionId, params.execution_generation);
					if (request) this.storeRequest(request);
				} else if (params.type === "approval.settled" || params.type === "clarify.settled") {
					this.removeRequests((item) => item.protocol === "canonical" && String(item.id) === String(payload.prompt_id) && item.sessionId === sessionId && (payload.execution_generation === void 0 || item.executionGeneration === payload.execution_generation));
					this.requestUpdates.set(JSON.stringify([
						"canonical",
						sessionId,
						payload.prompt_id
					]), ++this.requestVersion);
				}
				this.events.push(params);
				if (this.events.length > 2e3) this.events = this.events.slice(-2e3);
				return;
			}
			if (frame.method !== void 0 && id !== void 0) {
				const method = String(frame.method);
				const params = frame.params ?? {};
				if (method === "approval" || method === "clarify") {
					this.storeRequest({
						id,
						method,
						sessionId: typeof params.session_id === "string" ? params.session_id : void 0,
						params,
						receivedAt: Date.now()
					});
					this.events.push({
						type: "request.open",
						method,
						requestId: String(id)
					});
					return;
				}
				this.events.push({
					type: "unsupported_request",
					detail: `${method} 已被 DSH 明确拒绝（面板暂未实现该交互）`,
					method,
					requestId: id
				});
				if (this.events.length > 2e3) this.events = this.events.slice(-2e3);
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
				this.requests = [];
				this.requestUpdates.clear();
				this.rejectPending(/* @__PURE__ */ new Error("Gateway 连接已断开"));
			}
		};
	}
	rejectPending(error) {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
	release() {
		const ws = this.ws;
		this.ws = null;
		if (ws && ws.readyState === WebSocket.OPEN) ws.close();
		this.requests = [];
		this.requestUpdates.clear();
		this.rejectPending(/* @__PURE__ */ new Error("Gateway 连接已重置"));
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
		const requestVersion = this.requestVersion;
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) reject(/* @__PURE__ */ new Error(`Gateway RPC 超时: ${method}`));
			}, 15e3);
			const finish = () => clearTimeout(timer);
			this.pending.set(id, {
				resolve: (value) => {
					finish();
					if (method === "session.resume") this.restoreRequests(value, String(params.session_id ?? ""), requestVersion);
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
	/** 全量返回：面板轮询时用它对账，卡片消失即请求已被撤回。 */
	listRequests() {
		return this.requests;
	}
	requestKey(request) {
		return JSON.stringify([
			request.protocol ?? "rpc",
			request.sessionId,
			request.id
		]);
	}
	storeRequest(request) {
		const key = this.requestKey(request);
		this.requests = this.requests.filter((item) => this.requestKey(item) !== key);
		this.requests.push(request);
		this.requestUpdates.set(key, ++this.requestVersion);
	}
	removeRequests(matches) {
		this.requests = this.requests.filter((item) => {
			if (!matches(item)) return true;
			this.requestUpdates.set(this.requestKey(item), ++this.requestVersion);
			return false;
		});
	}
	canonicalRequest(prompt, sessionId, generation) {
		const method = prompt.kind;
		const executionGeneration = prompt.execution_generation ?? generation;
		if (method !== "approval" && method !== "clarify" || typeof prompt.prompt_id !== "string" || !sessionId || !Number.isSafeInteger(executionGeneration)) return void 0;
		const params = method === "clarify" ? {
			...prompt,
			session_id: sessionId,
			questions: [{
				qid: prompt.prompt_id,
				question: prompt.question,
				choices: prompt.choices,
				multi_select: prompt.multi_select
			}]
		} : {
			...prompt,
			session_id: sessionId,
			request_id: prompt.prompt_id
		};
		return {
			id: prompt.prompt_id,
			method,
			sessionId,
			params,
			protocol: "canonical",
			executionGeneration,
			receivedAt: Date.now()
		};
	}
	restoreRequests(value, requestedSession, version) {
		if (!value || typeof value !== "object") return;
		const snapshot = value;
		const sessionId = typeof snapshot.session_id === "string" ? snapshot.session_id : requestedSession;
		const restored = [];
		for (const raw of Array.isArray(snapshot.open_requests) ? snapshot.open_requests : []) {
			if (!raw || typeof raw !== "object") continue;
			const row = raw;
			if (row.method !== "approval" && row.method !== "clarify" || typeof row.id !== "string" && typeof row.id !== "number") continue;
			const params = row.params && typeof row.params === "object" ? row.params : {};
			restored.push({
				id: row.id,
				method: row.method,
				sessionId,
				params: {
					...params,
					session_id: sessionId
				},
				receivedAt: Date.now()
			});
		}
		for (const raw of Array.isArray(snapshot.prompts) ? snapshot.prompts : []) {
			if (!raw || typeof raw !== "object") continue;
			const request = this.canonicalRequest(raw, sessionId, snapshot.execution_generation);
			if (request) restored.push(request);
		}
		const changed = new Set([...this.requestUpdates].filter(([, updated]) => updated > version).map(([key]) => key));
		this.removeRequests((item) => item.sessionId === sessionId && !changed.has(this.requestKey(item)));
		for (const request of restored) if (!changed.has(this.requestKey(request))) this.storeRequest(request);
	}
	/** 按请求原协议回复：canonical 使用代次围栏，反向 RPC 保留服务端原 id。 */
	async respond(id, result) {
		const request = this.requests.find((item) => String(item.id) === String(id));
		if (!request) throw new Error("该请求已失效（可能已超时或被撤回）");
		if (request.protocol === "canonical") {
			const params = {
				session_id: request.sessionId,
				prompt_id: request.id,
				execution_generation: request.executionGeneration
			};
			if (request.method === "approval") {
				if (!Array.isArray(request.params.choices) || !request.params.choices.includes(result.choice)) throw new Error("该审批选项不在服务端允许的范围内");
				await this.rpc("approval.respond", {
					...params,
					choice: result.choice
				});
			} else {
				const answer = result.answers?.[String(request.id)];
				await this.rpc("clarify.respond", {
					...params,
					answer: typeof answer === "string" ? answer : ""
				});
			}
		} else {
			const ws = await this.ensureOpen();
			if (!this.requests.includes(request)) throw new Error("该请求已失效，请等待连接恢复");
			ws.send(JSON.stringify({
				jsonrpc: "2.0",
				id: request.id,
				result
			}));
		}
		this.removeRequests((item) => item === request);
	}
	/** 面板无法回答的交互：明确回错，别让 agent 一直等。 */
	async reject(id, message) {
		const index = this.requests.findIndex((item) => String(item.id) === String(id));
		if (index < 0) return;
		(await this.ensureOpen()).send(JSON.stringify({
			jsonrpc: "2.0",
			id,
			error: {
				code: -32e3,
				message
			}
		}));
		this.removeRequests((item) => item === this.requests[index]);
	}
	close() {
		this.release();
		this.state = "disconnected";
	}
};

//#endregion
//#region src/host/dashboardProxy.ts
/** Hermes 的 dashboard session token 是进程内随机值，浏览器拿不到。
*  插件 Host 在同一台机器、同一 OS 用户下读 `~/.hermes/.env` 的固定值，
*  再由本地反代在通过访问校验后注入上游请求与 WebSocket 握手。 */
function readDashboardToken() {
	const envPath = join(homedir(), ".hermes", ".env");
	let raw;
	try {
		raw = readFileSync(envPath, "utf8");
	} catch {
		return;
	}
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("HERMES_DASHBOARD_SESSION_TOKEN=")) continue;
		return trimmed.slice(31).trim() || void 0;
	}
}
function upstreamHost(target) {
	return `${target.host}:${target.port}`;
}
/** Hermes 只信任自己的 origin（CORS 与 WS 同一套规则），反代必须把它改写成目标 origin。 */
function upstreamOrigin(target) {
	return `http://${upstreamHost(target)}`;
}
/** Dashboard 的 WebSocket 用 URL 查询参数认证；HTTP 用 header，两者都要覆盖。 */
function withSessionToken(path, token) {
	const raw = path && path.length > 0 ? path : "/";
	const queryStart = raw.indexOf("?");
	const base = queryStart < 0 ? raw : raw.slice(0, queryStart);
	const query = queryStart < 0 ? "" : raw.slice(queryStart + 1);
	const params = new URLSearchParams(query);
	params.set("token", token);
	return `${base}?${params.toString()}`;
}
/** Dashboard 用同一个全局给 HTTP / WebSocket 携带凭据。
*  浏览器只拿到本次代理的能力值；持久 token 在通过入口校验后由 Host 替换。 */
function injectSessionToken(html, token, accessPath) {
	html = html.replaceAll(token, accessPath.slice(1));
	const script = `<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(accessPath.slice(1))};window.__HERMES_BASE_PATH__=${JSON.stringify(accessPath)};window.__HERMES_AUTH_REQUIRED__=false;<\/script>`;
	const head = html.indexOf("</head>");
	if (head >= 0) return `${html.slice(0, head)}${script}${html.slice(head)}`;
	return `${script}${html}`;
}
/** 逐条转发原始 header，替换 Host/Origin；再补上认证头。 */
function forwardHeaders(rawHeaders, target, token, accessPath) {
	const lines = [];
	for (let index = 0; index < rawHeaders.length; index += 2) {
		const name = rawHeaders[index];
		if (!name) continue;
		const lower = name.toLowerCase();
		if (lower === "host" || lower === "origin" || lower === "x-hermes-session-token" || lower === "x-forwarded-prefix") continue;
		lines.push(`${name}: ${rawHeaders[index + 1] ?? ""}`);
	}
	lines.push(`Host: ${upstreamHost(target)}`);
	lines.push(`Origin: ${upstreamOrigin(target)}`);
	lines.push(`X-Hermes-Session-Token: ${token}`);
	lines.push(`X-Forwarded-Prefix: ${accessPath}`);
	return lines.join("\r\n");
}
/** 起一个 loopback 反代：HTTP 与 WebSocket 都转发到 Hermes Dashboard，并注入 token。 */
async function startDashboardProxy(target, token, port = 0) {
	const accessPath = `/${randomBytes(32).toString("hex")}`;
	const sockets = /* @__PURE__ */ new Set();
	let origin = "";
	/** HTTP 与 WS 共用入口校验；先验证原始来源，再改写上游认证。
	*  URL 使用 Hermes 原生支持的 base path，让资源/API/WS 都携带同一能力路径。 */
	function authorizedPath(request, upgrade = false) {
		if (request.headers.host !== new URL(origin).host) return void 0;
		if (request.headers.origin !== void 0 && request.headers.origin !== origin) return void 0;
		if (upgrade && request.headers.origin !== origin) return void 0;
		const raw = request.url ?? "";
		if (!raw.startsWith(`${accessPath}/`) || raw.includes("\\") || raw.includes("#")) return void 0;
		const url = new URL(raw, origin);
		if (url.origin !== origin || !url.pathname.startsWith(`${accessPath}/`)) return void 0;
		if (url.searchParams.get("token") === accessPath.slice(1)) url.searchParams.delete("token");
		return `${url.pathname.slice(accessPath.length)}${url.search}`;
	}
	const server = http.createServer((request, response) => {
		const path = authorizedPath(request);
		if (!path) {
			response.writeHead(403, {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store"
			});
			response.end("Hermes 终端代理访问被拒绝");
			return;
		}
		const { "accept-encoding": _omitEncoding,...forwarded } = request.headers;
		const upstream = http.request({
			host: target.host,
			port: target.port,
			method: request.method,
			path,
			headers: {
				...forwarded,
				host: upstreamHost(target),
				origin: upstreamOrigin(target),
				"x-hermes-session-token": token,
				"x-forwarded-prefix": accessPath
			}
		}, (upstreamResponse) => {
			const status = upstreamResponse.statusCode ?? 502;
			const headers = { ...upstreamResponse.headers };
			headers["referrer-policy"] = "no-referrer";
			headers["cache-control"] = "no-store";
			const rawLocation = headers.location;
			for (const [name, value] of Object.entries(headers)) if (typeof value === "string") headers[name] = value.replaceAll(token, "[redacted]");
			else if (Array.isArray(value)) headers[name] = value.map((item) => item.replaceAll(token, "[redacted]"));
			if (rawLocation) try {
				const location = new URL(rawLocation, `${upstreamOrigin(target)}${path}`);
				if (location.origin === upstreamOrigin(target)) {
					const pathname = location.pathname.startsWith(`${accessPath}/`) ? location.pathname : `${accessPath}${location.pathname}`;
					headers.location = `${origin}${pathname}${location.search}${location.hash}`.replaceAll(token, accessPath.slice(1));
				}
			} catch {
				delete headers.location;
			}
			if (!String(headers["content-type"] ?? "").includes("text/html")) {
				response.writeHead(status, headers);
				upstreamResponse.pipe(response);
				return;
			}
			const chunks = [];
			upstreamResponse.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			upstreamResponse.on("end", () => {
				const body = Buffer.from(injectSessionToken(Buffer.concat(chunks).toString("utf8"), token, accessPath), "utf8");
				delete headers["transfer-encoding"];
				headers["content-length"] = String(body.length);
				response.writeHead(status, headers);
				response.end(body);
			});
		});
		upstream.on("error", (error) => {
			if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			response.end(`Hermes Dashboard 反代失败：${error.message}`);
		});
		request.pipe(upstream);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("upgrade", (request, socket, head) => {
		const path = authorizedPath(request, true);
		if (!path) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		const upstream = net.connect(target.port, target.host, () => {
			const headers = forwardHeaders(request.rawHeaders, target, token, accessPath);
			upstream.write(`${request.method ?? "GET"} ${withSessionToken(path, token)} HTTP/1.1\r\n${headers}\r\n\r\n`);
			if (head && head.length > 0) upstream.write(head);
		});
		let handshake = Buffer.alloc(0);
		let handshakeFinished = false;
		const readHandshake = (chunk) => {
			handshake = Buffer.concat([handshake, chunk]);
			const end = handshake.indexOf("\r\n\r\n");
			if (end < 0 && handshake.length <= 16384) return;
			handshakeFinished = true;
			upstream.off("data", readHandshake);
			if (end < 0 || end > 16384 || !/^HTTP\/1\.[01] 101(?: |\r)/.test(handshake.toString("latin1", 0, end))) {
				socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
				upstream.destroy();
				return;
			}
			socket.write(handshake.toString("latin1", 0, end + 4).replaceAll(token, accessPath.slice(1)), "latin1");
			if (handshake.length > end + 4) socket.write(handshake.subarray(end + 4));
			upstream.pipe(socket);
			socket.pipe(upstream);
		};
		upstream.on("data", readHandshake);
		upstream.on("end", () => {
			if (!handshakeFinished) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
		socket.on("close", () => upstream.destroy());
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	return {
		origin,
		baseUrl: `${origin}${accessPath}`,
		close: () => new Promise((resolve) => {
			server.close(() => resolve());
			for (const socket of sockets) socket.destroy();
		})
	};
}

//#endregion
//#region src/host/HermesBridgeService.ts
/** canonical 会话的识别依据是**标题**：每个 profile 的 DB 里 title 唯一的 "Bot Chat"。
*  官方 Bot 模式首次进入也走同一条规则，所以这里必须用完全相同的字面量。 */
const BOT_CHAT_TITLE = "Bot Chat";
const Config = Schema.object({ profile: Schema.string().default("default").description("本机 Hermes profile 名") });
/** 流式渲染只关心这几类事件。`sessions.changed` / `platforms.changed` / `heartbeat` 是高频广播，
*  在 180ms 的流式轮询下会把通道塞满、把真正的 delta 挤掉。 */
const STREAM_EVENT_TYPES = new Set([
	"message.start",
	"message.delta",
	"message.interim",
	"message.complete",
	"thinking.delta",
	"reasoning.delta",
	"reasoning.available",
	"tool.start",
	"tool.complete",
	"tool.generating",
	"tool.progress",
	"agent.step",
	"session.usage",
	"session.info",
	"approval.request",
	"approval.settled",
	"clarify.request",
	"clarify.settled",
	"error",
	"unsupported_request"
]);
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
	hostCtx;
	defaultProfile;
	/** Hermes 每个 profile 跑独立的 gateway 实例，WS 只能操作它自己那个 profile：
	*  拿 default 的连接去 resume `obsidian-notes` 的会话会被 gateway 判 profile_mismatch，
	*  连 profiles.list 都读不到别人的 canonical_session。所以按 profile 各留一条连接。 */
	transports = /* @__PURE__ */ new Map();
	dashboardProxy;
	proxyTarget;
	proxyStarting = false;
	constructor(ctx, config = {}) {
		super(ctx, REMOTE_NAMESPACE);
		this.hostCtx = ctx;
		this.defaultProfile = typeof config.profile === "string" && config.profile ? config.profile : "default";
		this.ensureOnline(this.transportFor(this.defaultProfile)).catch((error) => {
			ctx.logger?.warn?.("hermes-workspace: initial gateway connect failed: %o", error);
		});
		ctx.logger?.info?.("hermes-workspace: gateway bridge started");
		ctx.effect(() => () => {
			for (const transport of this.transports.values()) transport.close();
			this.transports.clear();
			this.dashboardProxy?.close().catch(() => void 0);
			ctx.logger?.info?.("hermes-workspace: gateway bridge disposed");
		}, "hermes-workspace: dispose");
	}
	/** 同一个 profile 复用同一条连接；不同 profile 互不干扰。 */
	transportFor(profile) {
		const name = (profile ?? "").trim() || this.defaultProfile;
		let transport = this.transports.get(name);
		if (!transport) {
			transport = new GatewayTransport({ profile: name });
			this.transports.set(name, transport);
		}
		return transport;
	}
	/** `ensureConnected` 内部吞掉了异常（轮询场景不希望抛），这里靠状态回查把失败暴露给调用方。 */
	async ensureOnline(transport) {
		if (transport.status.state === "online") return;
		await transport.ensureConnected(0);
		const status = transport.status;
		if (status.state !== "online") throw new Error(status.errorMessage ?? "Hermes gateway 未连接");
	}
	/** 内嵌原生 Dashboard 需要 dashboard token，而它是进程内随机值；
	*  这里起一个 loopback 反代补上 `X-Hermes-Session-Token`，iframe 才能正常加载。
	*  代理失败只影响原生界面，不影响 RPC 通道。 */
	async ensureDashboardProxy(apiOrigin) {
		if (this.proxyStarting) return;
		if (this.proxyTarget === apiOrigin && this.dashboardProxy) return;
		const token = readDashboardToken();
		if (!token) {
			const previous = this.dashboardProxy;
			this.dashboardProxy = void 0;
			await previous?.close().catch(() => void 0);
			this.proxyTarget = apiOrigin;
			this.hostCtx.logger?.warn?.("hermes-workspace: 未在 ~/.hermes/.env 配置 HERMES_DASHBOARD_SESSION_TOKEN，原生界面不可用");
			return;
		}
		this.proxyStarting = true;
		try {
			await this.dashboardProxy?.close().catch(() => void 0);
			this.dashboardProxy = void 0;
			const url = new URL(apiOrigin);
			const proxy = await startDashboardProxy({
				host: url.hostname,
				port: Number(url.port || 80)
			}, token);
			this.dashboardProxy = proxy;
			this.proxyTarget = apiOrigin;
			this.hostCtx.logger?.info?.(`hermes-workspace: dashboard proxy ready at ${proxy.origin}`);
		} catch (error) {
			this.hostCtx.logger?.warn?.("hermes-workspace: dashboard proxy failed: %o", error);
		} finally {
			this.proxyStarting = false;
		}
	}
	async ping() {
		return {
			ok: true,
			plugin: PACKAGE_NAME,
			panelId: PANEL_ID,
			at: Date.now()
		};
	}
	/** 状态灯反映的是「当前正在看的那个 Bot」的连接，而不是默认 profile 的。 */
	async getConnectionStatus(request) {
		const transport = this.transportFor(request?.profile);
		transport.ensureConnected();
		const status = transport.status;
		if (status.state === "online" && status.apiOrigin) await this.ensureDashboardProxy(status.apiOrigin);
		return {
			...status,
			dashboardOrigin: this.proxyTarget === status.apiOrigin ? this.dashboardProxy?.baseUrl : void 0
		};
	}
	/** 只列 profile 目录，不逐个握手：N 个 Bot 拉起 N 个 gateway 太重。
	*  canonical_session 也只在「该 profile 自己的连接」里才读得准，所以这里不再拿它判断可点性，
	*  真正的会话解析推迟到用户点开某个 Bot 时（openBot）。 */
	async getBotRoster() {
		const transport = this.transportFor(this.defaultProfile);
		await this.ensureOnline(transport);
		const raw = await transport.rpc("profiles.list", { include_sessions: true });
		return {
			profiles: (raw.profiles ?? []).map((row) => {
				const botMeta = row.ui_meta?.["hermes-bots"];
				const displayName = String(row.display_name || botMeta?.title || row.name || "");
				return {
					name: String(row.name ?? ""),
					displayName,
					isDefault: Boolean(row.is_default),
					model: String(row.model ?? ""),
					description: String(row.description ?? ""),
					color: botMeta?.color == null ? void 0 : String(botMeta.color),
					canonicalSessionId: row.canonical_session?.id ? String(row.canonical_session.id) : void 0
				};
			}),
			botModeProtocol: Boolean(raw.bot_mode_protocol)
		};
	}
	/** 打开某个 Bot：连它自己的 gateway → 找 canonical 会话 → 没有就新建一条 → 恢复历史。
	*  没聊过的 Bot 也必须能点开，这是与官方 Bot 模式对齐的行为。 */
	async openBot(request) {
		const profile = String(request?.profile ?? "").trim() || this.defaultProfile;
		const transport = this.transportFor(profile);
		await this.ensureOnline(transport);
		const sessionId = await this.resolveCanonicalSession(transport, profile);
		return this.resumeOn(transport, sessionId);
	}
	/** 该 profile 的 gateway 只认自己的 DB，所以这条查询必须在它自己的连接上跑。 */
	async readCanonicalId(transport, profile) {
		const rows = (await transport.rpc("profiles.list", { include_sessions: true })).profiles ?? [];
		const id = (rows.find((item) => String(item.name ?? "") === profile) ?? rows[0])?.canonical_session?.id;
		return id == null || id === "" ? void 0 : String(id);
	}
	async resolveCanonicalSession(transport, profile) {
		const existing = await this.readCanonicalId(transport, profile);
		if (existing) return existing;
		try {
			const created = await transport.rpc("session.create", {
				profile,
				title: BOT_CHAT_TITLE,
				source: "gui",
				follow_profile_config: true
			});
			const sessionId = created.session_id == null ? "" : String(created.session_id);
			if (!sessionId) throw new Error("Hermes 没有返回新建会话的 id");
			return sessionId;
		} catch (error) {
			const retried = await this.readCanonicalId(transport, profile);
			if (retried) return retried;
			throw error instanceof Error ? error : new Error(String(error));
		}
	}
	async resumeSession(request) {
		const sessionId = String(request?.sessionId ?? "").trim();
		if (!sessionId) throw new Error("缺少 sessionId");
		const transport = this.transportFor(request?.profile);
		await this.ensureOnline(transport);
		return this.resumeOn(transport, sessionId);
	}
	async resumeOn(transport, sessionId) {
		const raw = await transport.rpc("session.resume", {
			session_id: sessionId,
			defer_history: true
		});
		const messages = (raw.messages ?? []).map((row, index) => ({
			id: String(row.message_uid ?? row.row_id ?? index),
			role: String(row.role ?? "unknown"),
			text: extractText(row.content),
			toolName: row.tool_name == null || row.tool_name === "" ? void 0 : String(row.tool_name),
			timestamp: row.timestamp == null ? void 0 : String(row.timestamp)
		}));
		return {
			sessionId: String(raw.session_id ?? sessionId),
			messages,
			messageCount: typeof raw.message_count === "number" ? raw.message_count : messages.length,
			running: Boolean(raw.running),
			openRequests: transport.listRequests().filter((item) => item.sessionId === String(raw.session_id ?? sessionId)),
			subscriptionId: raw.subscription_id == null ? void 0 : String(raw.subscription_id),
			executionGeneration: typeof raw.execution_generation === "number" ? raw.execution_generation : void 0
		};
	}
	/** 写入操作：仅在用户点击发送时调用，插件启动与恢复会话都不会自动发消息。
	*  Gateway 的 admission gate 要求每次提交带唯一的 submission_id（官方 Desktop 同样自动补 UUID）。 */
	async submitPrompt(request) {
		const sessionId = String(request?.sessionId ?? "").trim();
		const text = String(request?.text ?? "").trim();
		if (!sessionId || !text) return {
			accepted: false,
			errorMessage: "会话或消息为空"
		};
		try {
			const transport = this.transportFor(request?.profile);
			await this.ensureOnline(transport);
			await transport.rpc("prompt.submit", {
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
		const sessionId = String(request?.sessionId ?? "").trim();
		if (!sessionId) return {
			accepted: false,
			errorMessage: "缺少 sessionId"
		};
		if (typeof request?.executionGeneration !== "number") return {
			accepted: false,
			errorMessage: "缺少执行代次，请先恢复会话"
		};
		try {
			const transport = this.transportFor(request?.profile);
			await this.ensureOnline(transport);
			await transport.rpc("session.interrupt", {
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
	/** 事件按连接隔离，必须读当前 Bot 那条，否则会把别的 profile 的事件混进来。
	*  顺带把「还等着用户决定的审批/提问」一并带回去，省一次往返。 */
	async getEvents(request) {
		const transport = this.transportFor(request?.profile);
		return {
			events: transport.drainEvents().filter((event) => STREAM_EVENT_TYPES.has(String(event.type))),
			requests: transport.listRequests()
		};
	}
	/** 用户在面板里点了审批 / 提交了回答，用原 request id 回包给 gateway。 */
	async respondRequest(request) {
		try {
			await this.transportFor(request?.profile).respond(request?.id, request?.result ?? {});
			return { accepted: true };
		} catch (error) {
			return {
				accepted: false,
				errorMessage: error instanceof Error ? error.message : String(error)
			};
		}
	}
};
const prototype = HermesBridgeService.prototype;
for (const name of [
	"ping",
	"getConnectionStatus",
	"getBotRoster",
	"openBot",
	"resumeSession",
	"submitPrompt",
	"interruptSession",
	"getEvents",
	"respondRequest"
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