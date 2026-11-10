import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

//#region src/shared/constants.ts
/** 插件包名，与 package.json name 一致。 */
const PACKAGE_NAME = "@jackdu/dsh-hermes-workspace";
/** Loader 行 id / 左侧面板 id / main keyed slot key。 */
const PANEL_ID = "hermes-workspace";
/** Typert Remote namespace，Client 通过 ctx.remote.hermesWorkspace 访问。 */
const REMOTE_NAMESPACE = "hermesWorkspace";
/** 凭据记录 id；完整 key 为 `@jackdu/dsh-hermes-workspace/default-api-key`。 */
const API_KEY_RECORD_ID = "default-api-key";

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
//#region src/host/HermesCredentialStore.ts
/** 不依赖 @deepseek-ai/dsh-credentials 包解析；运行时 key 就是 owner/id 字符串。 */
const RECORD_KEY = `${PACKAGE_NAME}/${API_KEY_RECORD_ID}`;
var HermesCredentialStore = class {
	constructor(credentials) {
		this.credentials = credentials;
	}
	async hasToken() {
		if (!this.credentials) return false;
		return (await this.credentials.describeRecord(RECORD_KEY)).configured;
	}
	async readToken() {
		if (!this.credentials) return void 0;
		const record = await this.credentials.readRecord(RECORD_KEY);
		return (record?.kind === "api-key" ? record.key?.trim() : void 0) || void 0;
	}
	async saveToken(token) {
		if (!this.credentials) throw new Error("当前 profile 没有 Credentials 服务");
		const value = token.trim();
		if (!value) throw new Error("Token 不能为空");
		await this.credentials.modifyRecord(RECORD_KEY, async () => ({
			kind: "api-key",
			key: value
		}));
	}
};

//#endregion
//#region src/host/HermesBridgeService.ts
var HermesBridgeService = class extends TypertRemoteService {
	static inject = ["credentials"];
	credentials;
	host;
	constructor(ctx) {
		super(ctx, REMOTE_NAMESPACE);
		this.host = ctx;
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
	async getConnectionStatus() {
		const config = this.readConfig();
		const hasToken = await this.credentials.hasToken();
		if (!config.baseUrl) return {
			state: "unconfigured",
			displayName: config.displayName,
			profile: config.profile,
			hasToken,
			errorCode: "unconfigured",
			errorMessage: "填写 Hermes Desktop 当前转发的 dashboard 地址，例如 http://127.0.0.1:<动态端口>"
		};
		return this.probe(config, hasToken);
	}
	async saveConnectionConfig(request) {
		const baseUrl = normalizeBaseUrl(request.baseUrl);
		const displayName = request.displayName.trim() || "Hermes";
		const profile = request.profile.trim();
		await this.writeConfig({
			baseUrl,
			displayName,
			profile
		});
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
			const text = extractText(item);
			return [{
				id: String(item.id ?? item.message_id ?? `${item.role ?? "unknown"}-${Math.random()}`),
				role: String(item.role ?? item.type ?? "unknown"),
				text
			}];
		}).reverse();
		return {
			sessionId: String(raw.session_id ?? sessionId),
			messages
		};
	}
	async probe(config, hasToken) {
		const token = await this.credentials.readToken();
		const client = new HermesApiClient(config.baseUrl, token);
		try {
			const health = await client.getJson("/api/health");
			if (health.ok !== true) return status(config, hasToken, "incompatible", "当前入口没有返回 Hermes /api/health ok");
			if (!token) return status(config, hasToken, "unauthorized", "已连通 dashboard，但还没有保存 session token", String(health.displayVersion ?? health.version ?? ""));
			await client.getJson("/api/auth/me");
			return status(config, hasToken, "online", void 0, String(health.displayVersion ?? health.version ?? ""));
		} catch (error) {
			return this.mapError(config, hasToken, error);
		}
	}
	mapError(config, hasToken, error) {
		if (error instanceof HermesHttpError) return status(config, hasToken, error.code, error.message);
		return status(config, hasToken, "offline", error instanceof Error ? error.message : String(error));
	}
	async requireClient() {
		const config = this.readConfig();
		if (!config.baseUrl) throw Object.assign(/* @__PURE__ */ new Error("尚未配置 dashboard 地址"), { code: "unconfigured" });
		const token = await this.credentials.readToken();
		if (!token) throw Object.assign(/* @__PURE__ */ new Error("尚未保存 session token"), { code: "unauthorized" });
		return {
			client: new HermesApiClient(config.baseUrl, token),
			profile: config.profile
		};
	}
	readConfig() {
		const raw = this.host.fiber?.entry?.config ?? {};
		return {
			baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
			displayName: typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName : "Hermes",
			profile: typeof raw.profile === "string" ? raw.profile : ""
		};
	}
	async writeConfig(next) {
		const entry = this.host.fiber?.entry;
		const editor = this.host.get?.("configEditor");
		if (!entry || !editor) throw new Error("当前 profile 无法保存插件配置");
		await editor.edit(entry, (current) => ({
			...current,
			...next
		}));
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
export { HermesBridgeService, HermesBridgeService as default };