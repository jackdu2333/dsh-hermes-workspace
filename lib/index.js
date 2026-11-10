import Schema from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

//#region src/shared/constants.ts
/** 插件包名，与 package.json name 一致。 */
const PACKAGE_NAME = "@jackdu/dsh-hermes-workspace";
/** Loader 行 id / 左侧面板 id / main keyed slot key。 */
const PANEL_ID = "hermes-workspace";
/** Typert Remote namespace，Client 通过 ctx.remote.hermesWorkspace 访问。 */
const REMOTE_NAMESPACE = "hermesWorkspace";
/** Credentials 的 scope 段，须匹配 /^[a-z][a-z0-9-]*$/，不能用包名（含 @ 和 /）。 */
const CREDENTIAL_SCOPE = "hermes-workspace";
/** 凭据记录 id；完整 key 为 `hermes-workspace/default-api-key`。 */
const API_KEY_RECORD_ID = "default-api-key";
/** 连接配置记录（不含密钥正文以外的 token 时仍走 Credentials）。 */
const CONNECTION_RECORD_ID = "connection";

//#endregion
//#region src/host/url.ts
const ALLOWED_HOSTS = new Set([
	"127.0.0.1",
	"localhost",
	"::1"
]);
function normalizeBaseUrl(raw) {
	const trimmed = raw.trim();
	if (!trimmed) throw Object.assign(/* @__PURE__ */ new Error("请填写 Hermes dashboard 地址"), { code: "unconfigured" });
	let parsed;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw Object.assign(/* @__PURE__ */ new Error("地址不是合法 URL"), { code: "incompatible" });
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw Object.assign(/* @__PURE__ */ new Error("只允许 http 或 https"), { code: "incompatible" });
	if (parsed.username || parsed.password) throw Object.assign(/* @__PURE__ */ new Error("URL 不能包含用户名或密码"), { code: "incompatible" });
	const host = parsed.hostname.toLowerCase();
	if (!ALLOWED_HOSTS.has(host)) throw Object.assign(/* @__PURE__ */ new Error("P0 只允许访问本机回环地址（SSH 隧道本地端口）"), { code: "incompatible" });
	parsed.hash = "";
	parsed.search = "";
	const path = parsed.pathname.replace(/\/+$/, "");
	parsed.pathname = path === "/" ? "" : path;
	return parsed.toString().replace(/\/+$/, "");
}
function joinUrl(baseUrl, path) {
	return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

//#endregion
//#region src/host/HermesApiClient.ts
var HermesHttpError = class extends Error {
	status;
	code;
	constructor(status$1, message, code) {
		super(message);
		this.status = status$1;
		this.code = code ?? mapStatus(status$1);
	}
};
function mapStatus(status$1) {
	if (status$1 === 401 || status$1 === 403) return "unauthorized";
	if (status$1 === 404) return "incompatible";
	if (status$1 === 0) return "offline";
	return "offline";
}
var HermesApiClient = class {
	constructor(baseUrl, token) {
		this.baseUrl = baseUrl;
		this.token = token;
	}
	async getJson(path, signal) {
		const headers = { Accept: "application/json" };
		if (this.token) {
			headers["X-Hermes-Session-Token"] = this.token;
			headers.Authorization = `Bearer ${this.token}`;
		}
		let response;
		try {
			response = await fetch(joinUrl(this.baseUrl, path), {
				headers,
				signal,
				redirect: "error"
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new HermesHttpError(0, message.includes("ECONNREFUSED") ? "Hermes dashboard 未启动，或 SSH 隧道本地端口已变化" : `无法连接 Hermes：${message}`, "offline");
		}
		const text = await response.text();
		if (!response.ok) throw new HermesHttpError(response.status, userMessage(response.status, text));
		if (!text) return {};
		try {
			return JSON.parse(text);
		} catch {
			throw new HermesHttpError(response.status, "Hermes 返回了无法解析的 JSON", "incompatible");
		}
	}
};
function userMessage(status$1, body) {
	if (status$1 === 401 || status$1 === 403) return "Token 无效或未配置。请粘贴 Hermes Desktop 当前 dashboard token。";
	if (status$1 === 404) return "当前入口不是 Hermes dashboard，或路径不匹配。";
	return body.replace(/\s+/g, " ").slice(0, 180) || `Hermes 返回 HTTP ${status$1}`;
}

//#endregion
//#region src/host/discover.ts
/** 官方默认 9119，以及本机当前已确认带 SPA 的 dashboard 端口。 */
const SPA_CANDIDATES = ["http://127.0.0.1:9119", "http://127.0.0.1:58559"];
async function discoverHermesDesktop() {
	const raw = await readFile(join(join(homedir(), ".hermes"), "gateway-connections.json"), "utf8");
	const doc = JSON.parse(raw);
	const ssh = (doc.connections ?? []).find((item) => item.kind === "ssh") ?? (doc.connections ?? []).find((item) => item.id === doc.lastUsed);
	const token = ssh?.token?.encoding === "plain" ? ssh.token.value?.trim() : void 0;
	return {
		baseUrl: (await discoverDashboardSpa())?.url?.replace(/\/chat$/, ""),
		token,
		displayName: ssh?.label || "Hermes",
		profile: "default"
	};
}
/** 官方原生网页对话区：`hermes dashboard` 的 `/chat`。headless `hermes serve` 不算。 */
async function discoverDashboardSpa() {
	for (const url of SPA_CANDIDATES) {
		const found = await inspectSpa(url);
		if (found) return found;
	}
}
async function inspectSpa(baseUrl) {
	try {
		const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat`, {
			redirect: "error",
			headers: { Accept: "text/html" },
			signal: AbortSignal.timeout(2e3)
		});
		if (!response.ok) return void 0;
		const html = await response.text();
		if (html.includes("Headless backend") || html.includes("web UI disabled")) return void 0;
		if (!html.includes("Hermes Agent") && !html.includes("/assets/")) return void 0;
		let version;
		try {
			version = (await new HermesApiClient(baseUrl, void 0).getJson("/api/status")).version;
		} catch {
			version = void 0;
		}
		return {
			url: `${baseUrl.replace(/\/+$/, "")}/chat`,
			version
		};
	} catch {
		return;
	}
}

//#endregion
//#region src/host/HermesCredentialStore.ts
const TOKEN_KEY = `${CREDENTIAL_SCOPE}/${API_KEY_RECORD_ID}`;
const CONNECTION_KEY = `${CREDENTIAL_SCOPE}/${CONNECTION_RECORD_ID}`;
var HermesCredentialStore = class {
	constructor(credentials) {
		this.credentials = credentials;
	}
	async hasToken() {
		if (!this.credentials) return false;
		return (await this.credentials.describeRecord(TOKEN_KEY)).configured;
	}
	async readToken() {
		if (!this.credentials) return void 0;
		const record = await this.credentials.readRecord(TOKEN_KEY);
		return (record?.kind === "api-key" ? record.key?.trim() : void 0) || void 0;
	}
	async saveToken(token) {
		const value = token.trim();
		if (!value) throw new Error("Token 不能为空");
		await this.modify(TOKEN_KEY, async () => ({
			kind: "api-key",
			key: value
		}));
	}
	async readConnection() {
		if (!this.credentials) return {};
		const record = await this.credentials.readRecord(CONNECTION_KEY);
		const payload = record?.kind === "grant" ? record.payload : void 0;
		if (!payload || typeof payload !== "object") return {};
		const data = payload;
		return {
			baseUrl: typeof data.baseUrl === "string" ? data.baseUrl : "",
			displayName: typeof data.displayName === "string" ? data.displayName : "",
			profile: typeof data.profile === "string" ? data.profile : ""
		};
	}
	async saveConnection(config) {
		await this.modify(CONNECTION_KEY, async () => ({
			kind: "grant",
			payload: {
				baseUrl: config.baseUrl,
				displayName: config.displayName,
				profile: config.profile
			}
		}));
	}
	async modify(key, mutate) {
		if (!this.credentials) throw new Error("当前 profile 没有 Credentials 服务，无法保存连接");
		await this.credentials.modifyRecord(key, mutate);
	}
};

//#endregion
//#region src/host/HermesBridgeService.ts
const Config = Schema.object({
	baseUrl: Schema.string().default("").description("Hermes dashboard URL，例如 http://127.0.0.1:59585"),
	displayName: Schema.string().default("Hermes"),
	profile: Schema.string().default("default")
});
var HermesBridgeService = class extends TypertRemoteService {
	static inject = ["credentials"];
	static Config = Config;
	credentials;
	rowConfig;
	constructor(ctx, config = {}) {
		super(ctx, REMOTE_NAMESPACE);
		this.rowConfig = {
			baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : "",
			displayName: typeof config.displayName === "string" && config.displayName.trim() ? config.displayName : "Hermes",
			profile: typeof config.profile === "string" ? config.profile : "default"
		};
		this.credentials = new HermesCredentialStore(ctx.credentials ?? ctx.get?.("credentials"));
		ctx.logger?.info?.("hermes-workspace: host bridge started");
		ctx.effect(() => () => {
			ctx.logger?.info?.("hermes-workspace: host bridge disposed");
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
	async getNativeChatTarget() {
		const spa = await discoverDashboardSpa();
		if (spa) return {
			available: true,
			url: spa.url,
			version: spa.version
		};
		return {
			available: false,
			errorMessage: "本机没有可用的 hermes dashboard（原生 /chat）。当前 SSH 后端是 headless serve，没有网页对话区。请先运行 hermes dashboard。"
		};
	}
	async openNativeChat() {
		const spa = await discoverDashboardSpa();
		if (spa) {
			const opened = await tryOpen(["open", spa.url]);
			if (opened.ok) return {
				ok: true,
				method: "dashboard"
			};
			return {
				ok: false,
				method: "dashboard",
				errorMessage: opened.errorMessage
			};
		}
		if ((await tryOpen(["open", "hermes://open/"])).ok) return {
			ok: true,
			method: "deeplink"
		};
		if ((await tryOpen([
			"open",
			"-a",
			"Hermes"
		])).ok) return {
			ok: true,
			method: "app"
		};
		return {
			ok: false,
			method: "app",
			errorMessage: "找不到 Hermes 原生对话区。请运行 hermes dashboard，或打开 Hermes Desktop。"
		};
	}
	async getConnectionStatus() {
		const config = await this.resolveConfig();
		const hasToken = await this.credentials.hasToken();
		if (!config.baseUrl) return {
			state: "unconfigured",
			displayName: config.displayName,
			profile: config.profile,
			hasToken,
			errorCode: "unconfigured",
			errorMessage: "还没有可用的 dashboard 地址。先打开 Hermes Desktop 连上 SSH，或手动填写当前转发端口。"
		};
		return this.probe(config, hasToken);
	}
	async saveConnectionConfig(request) {
		const next = {
			baseUrl: normalizeBaseUrl(request.baseUrl),
			displayName: request.displayName.trim() || "Hermes",
			profile: request.profile.trim() || "default"
		};
		await this.credentials.saveConnection(next);
		return { ok: true };
	}
	async saveApiKey(request) {
		await this.credentials.saveToken(request.token);
		return { ok: true };
	}
	async testConnection() {
		return this.getConnectionStatus();
	}
	async listSessions() {
		const { client, profile } = await this.requireClient();
		const query = new URLSearchParams({
			limit: "40",
			offset: "0",
			order: "recent",
			archived: "exclude"
		});
		if (profile) query.set("profile", profile);
		const raw = await client.getJson(`/api/sessions?${query}`);
		const sessions = (Array.isArray(raw.sessions) ? raw.sessions : []).flatMap((row) => {
			if (!row || typeof row !== "object") return [];
			const item = row;
			const id = String(item.id ?? item.session_id ?? "");
			if (!id) return [];
			return [{
				id,
				title: String(item.title ?? item.name ?? id),
				source: typeof item.source === "string" ? item.source : void 0,
				updatedAt: String(item.updated_at ?? item.updatedAt ?? item.last_activity ?? ""),
				messageCount: typeof item.message_count === "number" ? item.message_count : void 0
			}];
		});
		return {
			sessions,
			total: typeof raw.total === "number" ? raw.total : sessions.length
		};
	}
	async getSessionMessages(request) {
		const sessionId = request.sessionId.trim();
		if (!sessionId) throw new Error("缺少 sessionId");
		const { client, profile } = await this.requireClient();
		const query = new URLSearchParams({
			limit: "80",
			order: "latest"
		});
		if (profile) query.set("profile", profile);
		const raw = await client.getJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages?${query}`);
		const messages = (Array.isArray(raw.messages) ? raw.messages : []).flatMap((row) => {
			if (!row || typeof row !== "object") return [];
			const item = row;
			return [{
				id: String(item.id ?? item.message_id ?? `${item.role ?? "unknown"}`),
				role: String(item.role ?? item.type ?? "unknown"),
				text: extractText(item)
			}];
		}).reverse();
		return {
			sessionId: String(raw.session_id ?? sessionId),
			messages
		};
	}
	async resolveConfig() {
		const saved = await this.credentials.readConnection();
		const discovered = await discoverHermesDesktop().catch(() => void 0);
		if (!await this.credentials.readToken() && discovered?.token) await this.credentials.saveToken(discovered.token);
		return {
			baseUrl: saved.baseUrl || discovered?.baseUrl || this.rowConfig.baseUrl,
			displayName: saved.displayName || discovered?.displayName || this.rowConfig.displayName || "Hermes",
			profile: saved.profile || discovered?.profile || this.rowConfig.profile || "default"
		};
	}
	async probe(config, hasToken) {
		const token = await this.credentials.readToken();
		const client = new HermesApiClient(config.baseUrl, token);
		try {
			const health = await client.getJson("/api/health");
			if (health.ok !== true) return status(config, hasToken, "incompatible", "当前入口没有返回 Hermes /api/health ok");
			if (!token) return status(config, true, "unauthorized", "已连通 dashboard，但还没有 session token", String(health.displayVersion ?? health.version ?? ""));
			await client.getJson("/api/auth/me");
			return status(config, true, "online", void 0, String(health.displayVersion ?? health.version ?? ""));
		} catch (error) {
			return this.mapError(config, hasToken || Boolean(token), error);
		}
	}
	mapError(config, hasToken, error) {
		if (error instanceof HermesHttpError) return status(config, hasToken, error.code, error.message);
		return status(config, hasToken, "offline", error instanceof Error ? error.message : String(error));
	}
	async requireClient() {
		const config = await this.resolveConfig();
		if (!config.baseUrl) throw Object.assign(/* @__PURE__ */ new Error("尚未配置 dashboard 地址"), { code: "unconfigured" });
		const token = await this.credentials.readToken();
		if (!token) throw Object.assign(/* @__PURE__ */ new Error("尚未保存 session token"), { code: "unauthorized" });
		return {
			client: new HermesApiClient(config.baseUrl, token),
			profile: config.profile
		};
	}
};
function status(config, hasToken, state, errorMessage, version) {
	return {
		state,
		displayName: config.displayName,
		profile: config.profile,
		baseUrl: config.baseUrl,
		version,
		lastCheckedAt: Date.now(),
		hasToken,
		errorCode: state === "online" ? void 0 : state,
		errorMessage
	};
}
function tryOpen(argv) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), {
			stdio: "ignore",
			detached: true
		});
		child.once("error", (error) => resolve({
			ok: false,
			errorMessage: error.message
		}));
		child.once("spawn", () => {
			child.unref();
			resolve({ ok: true });
		});
	});
}
function extractText(item) {
	if (typeof item.content === "string") return item.content;
	if (typeof item.text === "string") return item.text;
	if (Array.isArray(item.content)) return item.content.map((part) => {
		if (typeof part === "string") return part;
		if (part && typeof part === "object" && "text" in part) return String(part.text ?? "");
		return "";
	}).filter(Boolean).join("\n");
	return "";
}
const prototype = HermesBridgeService.prototype;
for (const name of [
	"ping",
	"getNativeChatTarget",
	"openNativeChat",
	"getConnectionStatus",
	"saveConnectionConfig",
	"saveApiKey",
	"testConnection",
	"listSessions",
	"getSessionMessages"
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