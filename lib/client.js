window.__ModuleLoader__.load({ id: "@jackdu/dsh-hermes-workspace", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/shared/constants.ts
/** 插件包名，与 package.json name 一致。 */
const PACKAGE_NAME = "@jackdu/dsh-hermes-workspace";
/** Loader 行 id / 左侧面板 id / main keyed slot key。 */
const PANEL_ID = "hermes-workspace";
/** Typert Remote namespace，Client 通过 ctx.remote.hermesWorkspace 访问。 */
const REMOTE_NAMESPACE = "hermesWorkspace";

//#endregion
//#region src/client/index.tsx
/** Client 侧 contribution 必须复刻官方 `createTypertRemoteInfo` 的产出形状：
*  descriptor 带 strict codec 与 input/invoke 能力，contribution 额外暴露 methods 映射。
*  宿主 `$mount` 按 generated Remote 的形状校验，缺字段会在挂载期直接抛错。
*  passthrough schema 避免引入浏览器侧不存在的 zod。 */
/** 带参数的 RPC 必须在 contribution 里逐个声明：宿主按这里的 parameters 解析入参，
*  漏掉一个就会以「参数为空」调用，表现为 profile 丢失、连回 default。 */
const METHOD_PARAMETERS = {
	getConnectionStatus: ["request"],
	openBot: ["request"],
	resumeSession: ["request"],
	submitPrompt: ["request"],
	interruptSession: ["request"],
	getEvents: ["request"],
	respondRequest: ["request"]
};
const METHOD_NAMES = [
	"ping",
	"getConnectionStatus",
	"getBotRoster",
	"openBot",
	"resumeSession",
	"submitPrompt",
	"interruptSession",
	"getEvents",
	"respondRequest"
];
function buildContribution() {
	const methods = Object.create(null);
	return {
		package: PACKAGE_NAME,
		descriptors: METHOD_NAMES.map((method) => {
			const passthrough = () => ({ parse: (value) => value });
			const descriptor = {
				id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}`,
				service: REMOTE_NAMESPACE,
				namespace: REMOTE_NAMESPACE,
				method,
				invocation: { kind: "direct" },
				parameters: (METHOD_PARAMETERS[method] ?? []).map((name) => ({
					name,
					wire: name,
					source: "json",
					codec: {
						mode: "strict",
						typeSymbol: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}:${name}`,
						create: passthrough,
						jsonSchema: {}
					}
				})),
				result: {
					mode: "strict",
					typeSymbol: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}:result`,
					create: passthrough,
					jsonSchema: {}
				},
				input: passthrough,
				invoke: () => {
					throw new Error("hermes-workspace: 该方法的入参由宿主侧解析，Client 不直接 invoke");
				}
			};
			methods[`${REMOTE_NAMESPACE}/${method}`] = descriptor;
			return descriptor;
		}),
		methods
	};
}
const TYPERT_REMOTE = buildContribution();
const inject = [
	"slots",
	"layout",
	"remote"
];
/** 把堆栈首帧压成一行，供面板内定位挂载失败的具体位置。 */
function describeFrame(error) {
	const frame = error.stack?.split("\n").find((line) => line.trim().startsWith("at "));
	return frame ? ` @ ${frame.trim().slice(0, 180)}` : "";
}
/** 面板注册必须与 Remote 挂载解耦：$mount 失败时仍要注册侧边栏入口和面板，
*  否则界面上没有任何可点入口，连失败原因都看不到。挂载错误改为面板内可见的诊断信息。
*  同时不能 rethrow：DSH Web boot 只要有 entry 未激活就整体失败。 */
async function apply(ctx) {
	let mountError = null;
	try {
		await ctx.remote.$mount(TYPERT_REMOTE);
	} catch (error) {
		mountError = error instanceof Error ? `${error.message}${describeFrame(error)}` : String(error);
		ctx.logger?.error?.("hermes-workspace: remote mount failed: %o", error);
	}
	const holder = {};
	try {
		ctx.inject(["remote.hermesWorkspace"], (child) => {
			holder.current = child.remote.hermesWorkspace;
		});
	} catch (error) {
		ctx.logger?.error?.("hermes-workspace: remote namespace binding failed: %o", error);
	}
	try {
		registerWorkspace(ctx, mountError, holder);
	} catch (error) {
		ctx.logger?.error?.("hermes-workspace: panel registration failed: %o", error);
	}
}
function unwrap(result) {
	if (result.ok) return result.value;
	throw result.error;
}
/** 每次调用时再取 Remote 服务：挂载可能晚于面板注册，不能用注册时的快照。 */
function createApi(getRemote) {
	async function call(method, ...args) {
		const invoke = getRemote()?.[method];
		if (typeof invoke !== "function") throw new Error(`Hermes 服务尚未就绪（${method}）`);
		return unwrap(await invoke(...args));
	}
	return {
		getConnectionStatus: (request) => call("getConnectionStatus", request),
		getBotRoster: () => call("getBotRoster"),
		openBot: (request) => call("openBot", request),
		resumeSession: (request) => call("resumeSession", request),
		submitPrompt: (request) => call("submitPrompt", request),
		interruptSession: (request) => call("interruptSession", request),
		getEvents: (request) => call("getEvents", request),
		respondRequest: (request) => call("respondRequest", request)
	};
}
function registerWorkspace(ctx, mountError, holder) {
	const api = createApi(() => holder.current);
	ctx.slots.inject("main", () => ctx.slots.register({
		name: "main",
		key: PANEL_ID,
		inject: () => ({
			api,
			mountError
		})
	}, HermesChatPanel));
	ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
		name: "sidebar.panellist",
		id: PANEL_ID,
		order: 18,
		label: () => "Hermes"
	}, HermesIcon));
}
function HermesIcon(props) {
	const size = props.size ?? 20;
	const color = props.active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
		viewBox: "0 0 24 24",
		width: size,
		height: size,
		"aria-hidden": "true",
		focusable: "false",
		style: { display: "block" },
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			fill: color,
			d: "M12 2.5c.4 0 .7.2.9.5l1.8 3.1 3.5.6c.8.1 1.1 1.1.5 1.7l-2.6 2.6.6 3.6c.1.8-.7 1.4-1.4 1L12 14.4l-3.3 1.7c-.7.4-1.5-.2-1.4-1l.6-3.6L5.3 8.4c-.6-.6-.3-1.6.5-1.7l3.5-.6L11.1 3c.2-.3.5-.5.9-.5Z"
		})
	});
}
/** 折叠行左侧的小标识：四角星，暗示「这是模型的思考动作」。 */
function SparkIcon({ size = 11 }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
		viewBox: "0 0 16 16",
		width: size,
		height: size,
		"aria-hidden": "true",
		style: { display: "block" },
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			fill: "currentColor",
			d: "M8 1.4c.28 0 .53.18.62.45l.92 2.85a2.4 2.4 0 0 0 1.53 1.53l2.85.92a.66.66 0 0 1 0 1.25l-2.85.92a2.4 2.4 0 0 0-1.53 1.53l-.92 2.85a.66.66 0 0 1-1.25 0l-.92-2.85a2.4 2.4 0 0 0-1.53-1.53l-2.85-.92a.66.66 0 0 1 0-1.25l2.85-.92A2.4 2.4 0 0 0 6.45 4.7l.92-2.85A.66.66 0 0 1 8 1.4Z"
		})
	});
}
function ChevronIcon({ size = 10 }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
		viewBox: "0 0 12 12",
		width: size,
		height: size,
		"aria-hidden": "true",
		style: { display: "block" },
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M4.5 2.5 8 6l-3.5 3.5",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: "1.6",
			strokeLinecap: "round",
			strokeLinejoin: "round"
		})
	});
}
function TerminalIcon({ size = 12 }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		viewBox: "0 0 16 16",
		width: size,
		height: size,
		"aria-hidden": "true",
		style: { display: "block" },
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
			x: "1.6",
			y: "2.6",
			width: "12.8",
			height: "10.8",
			rx: "2.2",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: "1.3"
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M4.4 6.2 6.3 8l-1.9 1.8M8.2 10h3.2",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: "1.3",
			strokeLinecap: "round",
			strokeLinejoin: "round"
		})]
	});
}
/** 把 Bot 配的主色稀释成头像底色。只接受简单颜色字面量，避免把外部字符串直接塞进 CSS。 */
function tint(color, percent) {
	if (!color) return void 0;
	if (!/^[#a-zA-Z0-9(),.%\s-]+$/.test(color)) return void 0;
	return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}
function emptyLive() {
	return {
		active: false,
		blocks: [],
		segmentBlock: /* @__PURE__ */ new Map()
	};
}
function stateLabel(state) {
	if (state === "online") return "已连接";
	if (state === "connecting") return "连接中";
	if (state === "error") return "连接失败";
	return "未连接";
}
function HermesChatPanel(props) {
	const api = props.api;
	const mountError = props.mountError ?? null;
	const [status, setStatus] = (0, react.useState)(null);
	const [profiles, setProfiles] = (0, react.useState)([]);
	const [sessionId, setSessionId] = (0, react.useState)(null);
	const [messages, setMessages] = (0, react.useState)([]);
	const [events, setEvents] = (0, react.useState)([]);
	/** 等用户决定的审批 / 提问；gateway 会一直阻塞到收到回包。 */
	const [requests, setRequests] = (0, react.useState)([]);
	const [draft, setDraft] = (0, react.useState)("");
	const [error, setError] = (0, react.useState)(null);
	const [busy, setBusy] = (0, react.useState)(false);
	/** chat：本插件的气泡对话（默认）；terminal：内嵌 Hermes 终端 TUI。
	*  注意：Hermes 桌面端那个带 BOTS 侧栏的气泡界面是 Electron 专属渲染层
	*  （依赖 window.hermesDesktop 预加载桥），iframe 无法承载，所以这里不提供。 */
	const [view, setView] = (0, react.useState)("chat");
	/** 当前 Bot 的 profile 名。Hermes 每个 profile 是独立 gateway，所有 RPC 都要带上它。 */
	const [activeProfile, setActiveProfile] = (0, react.useState)(null);
	/** 正在握手/建会话的 Bot，列表里用它显示「连接中」。 */
	const [pendingProfile, setPendingProfile] = (0, react.useState)(null);
	const sessionRef = (0, react.useRef)(null);
	const profileRef = (0, react.useRef)(null);
	const generationRef = (0, react.useRef)(void 0);
	const previousState = (0, react.useRef)("disconnected");
	const scrollRef = (0, react.useRef)(null);
	const textareaRef = (0, react.useRef)(null);
	/** 流式草稿放 ref 里累积：每个 delta 都 setState 会把 React 打爆，
	*  bumpLive 只负责在批量应用后触发一次重绘。 */
	const liveRef = (0, react.useRef)(emptyLive());
	const [liveVersion, setLiveVersion] = (0, react.useState)(0);
	const liveStartedAt = (0, react.useRef)(0);
	/** 刚提交、但还没在服务端历史里出现的消息。
	*  这期间任何一次历史刷新都会把它擦掉，表现就是「发出去没反应，等回复才一起冒出来」。 */
	const pendingTextRef = (0, react.useRef)(null);
	const pendingSinceRef = (0, react.useRef)(0);
	/** 只有视口贴底时才跟随新消息；用户往上翻历史时不再强行拽回底部。 */
	const stickToBottom = (0, react.useRef)(true);
	/** resume 同时提供历史与执行代次；后者是 interrupt / steer 的必需参数。 */
	function applyResume(resumed, profile) {
		sessionRef.current = resumed.sessionId;
		profileRef.current = profile;
		generationRef.current = resumed.executionGeneration;
		setActiveProfile(profile);
		setSessionId(resumed.sessionId);
		setMessages(resumed.messages);
	}
	/** 刷新历史 / 事件都要落在当前 Bot 自己那条连接上。 */
	function currentProfile() {
		return profileRef.current ?? void 0;
	}
	function resetLive() {
		liveRef.current = emptyLive();
		liveStartedAt.current = 0;
		setLiveVersion((value) => value + 1);
	}
	/** 把一批 gateway 事件折进流式草稿。
	*  `message.delta` 按 segment 分段到达，`offset` 是该 chunk 在段落内的起点：
	*  offset 落在已应用区间里说明是重发的帧（重连后 gateway 会重放），跳过即可。 */
	function applyEvents(incoming) {
		const live = liveRef.current;
		let changed = false;
		let completed = false;
		for (const event of incoming) {
			const payload = event.payload ?? {};
			switch (event.type) {
				case "message.start":
					if (!live.active) {
						live.blocks = [];
						live.segmentBlock.clear();
					}
					live.active = true;
					if (!liveStartedAt.current) liveStartedAt.current = Date.now();
					changed = true;
					break;
				case "message.delta": {
					const chunk = payload.text;
					if (chunk === null || chunk === void 0) {
						if (typeof payload.segment === "number") live.segmentBlock.delete(payload.segment);
						break;
					}
					const segment = typeof payload.segment === "number" ? payload.segment : 0;
					const offset = typeof payload.offset === "number" ? payload.offset : -1;
					let index = live.segmentBlock.get(segment);
					if (index === void 0) {
						live.blocks.push({
							kind: "text",
							text: ""
						});
						index = live.blocks.length - 1;
						live.segmentBlock.set(segment, index);
					}
					const block = live.blocks[index];
					if (block?.kind === "text") {
						const text = String(chunk);
						if (offset < 0 || offset >= block.text.length) block.text += text;
					}
					live.active = true;
					if (!liveStartedAt.current) liveStartedAt.current = Date.now();
					changed = true;
					break;
				}
				case "message.interim": {
					const text = typeof payload.text === "string" ? payload.text : "";
					if (payload.already_streamed !== true && text) {
						live.blocks.push({
							kind: "text",
							text
						});
						changed = true;
					}
					live.segmentBlock.clear();
					live.active = true;
					break;
				}
				case "tool.start": {
					const id = String(payload.tool_id ?? payload.name ?? `tool-${live.blocks.length}`);
					live.blocks.push({
						kind: "tool",
						id,
						name: String(payload.name ?? "工具调用"),
						status: "running"
					});
					live.segmentBlock.clear();
					live.active = true;
					if (!liveStartedAt.current) liveStartedAt.current = Date.now();
					changed = true;
					break;
				}
				case "tool.complete": {
					const id = String(payload.tool_id ?? "");
					const summary = typeof payload.summary === "string" && payload.summary ? payload.summary : void 0;
					const block = live.blocks.find((item) => item.kind === "tool" && item.id === id);
					if (block && block.kind === "tool") {
						block.status = "done";
						if (summary) block.summary = summary;
					} else live.blocks.push({
						kind: "tool",
						id,
						name: String(payload.name ?? "工具调用"),
						status: "done",
						summary
					});
					changed = true;
					break;
				}
				case "message.complete":
					live.active = false;
					completed = true;
					changed = true;
					break;
				case "session.info":
					if (payload.running === false && live.active && live.blocks.length > 0) {
						live.active = false;
						completed = true;
						changed = true;
					}
					break;
				default: break;
			}
		}
		if (changed) setLiveVersion((value) => value + 1);
		if (completed) refreshHistory().then(() => resetLive());
	}
	async function refreshHistory() {
		if (!api || !sessionRef.current) return;
		try {
			const resumed = await api.resumeSession({
				sessionId: sessionRef.current,
				profile: currentProfile()
			});
			const pending = pendingTextRef.current;
			if (pending && Date.now() - pendingSinceRef.current < 8e3) {
				if (!resumed.messages.some((message) => message.role === "user" && message.text.trim() === pending)) return;
			}
			pendingTextRef.current = null;
			applyResume(resumed, profileRef.current ?? "");
		} catch {}
	}
	async function loadRoster() {
		if (!api) return;
		const roster = await api.getBotRoster();
		setProfiles(roster.profiles);
		if (profileRef.current !== null) return;
		const preferred = roster.profiles.find((row) => row.isDefault) ?? roster.profiles[0];
		if (preferred) await openBot(preferred);
	}
	/** 打开 Bot：主机侧会连上该 profile 自己的 gateway、找（或建）canonical 会话再返回历史。
	*  所以列表项不能再按「有没有 sessionId」置灰——那个字段在别的 profile 上本来就读不到。 */
	async function openBot(row) {
		if (!api) return;
		setBusy(true);
		setPendingProfile(row.name);
		setError(null);
		try {
			resetLive();
			pendingTextRef.current = null;
			applyResume(await api.openBot({ profile: row.name }), row.name);
			stickToBottom.current = true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
			setPendingProfile(null);
		}
	}
	async function send() {
		const text = draft.trim();
		if (!api || !sessionId || !text) return;
		setBusy(true);
		setError(null);
		stickToBottom.current = true;
		try {
			const result = await api.submitPrompt({
				sessionId,
				text,
				profile: currentProfile()
			});
			if (!result.accepted) {
				setError(result.errorMessage ?? "消息未被接受");
				return;
			}
			setDraft("");
			pendingTextRef.current = text;
			pendingSinceRef.current = Date.now();
			setMessages((previous) => [...previous, {
				id: `pending-${Date.now()}`,
				role: "user",
				text
			}]);
			liveRef.current = emptyLive();
			liveRef.current.active = true;
			liveStartedAt.current = Date.now();
			setLiveVersion((value) => value + 1);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}
	/** 重发：把某条用户消息原样再提交一次（不覆盖输入框）。 */
	async function resend(text) {
		if (!api || !sessionId || !text.trim()) return;
		setBusy(true);
		setError(null);
		stickToBottom.current = true;
		try {
			const result = await api.submitPrompt({
				sessionId,
				text: text.trim(),
				profile: currentProfile()
			});
			if (!result.accepted) setError(result.errorMessage ?? "重发失败");
			else {
				pendingTextRef.current = text.trim();
				pendingSinceRef.current = Date.now();
				liveRef.current = emptyLive();
				liveRef.current.active = true;
				liveStartedAt.current = Date.now();
				setLiveVersion((value) => value + 1);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}
	async function interrupt() {
		if (!api || !sessionId) return;
		setBusy(true);
		try {
			const result = await api.interruptSession({
				sessionId,
				executionGeneration: generationRef.current,
				profile: currentProfile()
			});
			if (!result.accepted) setError(result.errorMessage ?? "中断失败");
			else {
				liveRef.current.active = false;
				setLiveVersion((value) => value + 1);
				window.setTimeout(() => void refreshHistory(), 600);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}
	/** 审批 / 提问的回包。result 的结构由 method 决定，原样交给 gateway。 */
	async function respond(request, result) {
		if (!api) return;
		setBusy(true);
		setError(null);
		try {
			const outcome = await api.respondRequest({
				id: request.id,
				result,
				profile: currentProfile()
			});
			if (!outcome.accepted) setError(outcome.errorMessage ?? "回复失败");
			else setRequests((previous) => previous.filter((item) => String(item.id) !== String(request.id)));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}
	(0, react.useEffect)(() => {
		if (!api) return;
		let cancelled = false;
		let timer;
		let lastStatusAt = 0;
		(async () => {
			try {
				await loadRoster();
			} catch (cause) {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			}
		})();
		const tick = async () => {
			if (cancelled) return;
			try {
				if (Date.now() - lastStatusAt > 1200) {
					lastStatusAt = Date.now();
					const next = await api.getConnectionStatus({ profile: currentProfile() });
					if (cancelled) return;
					setStatus(next);
					const recovered = previousState.current !== "online" && next.state === "online";
					previousState.current = next.state;
					if (recovered && sessionRef.current) await refreshHistory();
				}
				const page = await api.getEvents({ profile: currentProfile() });
				if (!cancelled && page.events.length) {
					setEvents((previous) => [...previous, ...page.events].slice(-40));
					applyEvents(page.events);
				}
				if (!cancelled) {
					const incoming = page.requests ?? [];
					setRequests((previous) => previous.length === incoming.length && previous.every((item, index) => item.id === incoming[index].id) ? previous : incoming);
				}
				if (liveRef.current.active && liveStartedAt.current && Date.now() - liveStartedAt.current > 12e3) {
					liveStartedAt.current = Date.now();
					await refreshHistory();
				}
			} catch {}
			if (!cancelled) timer = window.setTimeout(() => void tick(), liveRef.current.active ? 160 : 1200);
		};
		tick();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [api]);
	(0, react.useEffect)(() => {
		const el = scrollRef.current;
		if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
	}, [
		messages.length,
		sessionId,
		liveVersion
	]);
	(0, react.useEffect)(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
	}, [draft]);
	const state = status?.state ?? "disconnected";
	const active = profiles.find((row) => row.name === activeProfile) ?? null;
	const canSend = Boolean(sessionId) && !busy && Boolean(draft.trim());
	/** 原生界面走 Host 的本地反代（已注入 dashboard token），不能直连 gateway 端口。 */
	const nativeOrigin = status?.dashboardOrigin;
	/** `/bots` 只是导航壳子、没有对应页面组件（主区会全黑）。
	*  Dashboard 里真正的对话页是 `/chat?resume=<sessionId>`；未选 Bot 时退回会话列表。 */
	const nativeSrc = nativeOrigin ? sessionId ? `${nativeOrigin}/chat?resume=${encodeURIComponent(sessionId)}` : `${nativeOrigin}/sessions` : null;
	const headerInitial = active ? (active.displayName || active.name).slice(0, 1).toUpperCase() : "H";
	/** 只显示属于当前会话的请求；同一条连接可能还在跑别的会话。 */
	const visibleRequests = requests.filter((item) => !item.sessionId || item.sessionId === sessionId);
	/** 把连续的工具消息聚成一组，渲染成紧凑的胶囊簇（参考 AI 原生界面的 tool chips）。 */
	const blocks = [];
	for (const message of messages) {
		if (message.role === "assistant" && !message.text.trim()) continue;
		if (message.role === "tool") {
			const last = blocks[blocks.length - 1];
			if (last?.tools) last.tools.push(message);
			else blocks.push({
				key: `tool-${message.id}`,
				tools: [message]
			});
		} else blocks.push({
			key: message.id,
			message
		});
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: pageStyle,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: PANEL_CSS }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
				style: sidebarStyle,
				className: "hw-scroll",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: sidebarTitleStyle,
					children: "机器人"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: botListStyle,
					children: [profiles.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: sidebarEmptyStyle,
						children: "尚未读取到 Bot"
					}) : null, profiles.map((row) => {
						const selected = row.name === activeProfile;
						const opening = pendingProfile === row.name;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: "hw-bot",
							disabled: busy,
							onClick: () => void openBot(row),
							title: opening ? "正在连接 Hermes…" : `打开 ${row.displayName || row.name}`,
							style: {
								...botItemStyle,
								...selected ? botItemActiveStyle : {}
							},
							children: [
								selected ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: botActiveBarStyle }) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										...avatarStyle,
										...selected ? avatarActiveStyle : {},
										...row.color ? { background: tint(row.color, 18) } : {}
									},
									children: (row.displayName || row.name).slice(0, 1).toUpperCase()
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: botTextStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: botNameStyle,
										children: row.displayName || row.name
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: botPreviewStyle,
										children: opening ? "正在连接…" : row.description || row.model || "可继续对话"
									})]
								})
							]
						}, row.name);
					})]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: chatPaneStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: chatHeaderStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									...headerAvatarStyle,
									...active?.color ? { background: tint(active.color, 16) } : {}
								},
								children: headerInitial
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: chatTitleStyle,
								children: active ? active.displayName || active.name : "Bot 对话"
							}),
							active?.model ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: modelChipStyle,
								children: active.model
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: statusWrapStyle,
								title: status?.errorMessage ?? stateLabel(state),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
									...dotStyle,
									...state === "online" ? dotOkStyle : dotWarnStyle
								} }), stateLabel(state)]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: headerDividerStyle }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "hw-ghost",
								onClick: () => setView(view === "terminal" ? "chat" : "terminal"),
								style: ghostButtonStyle,
								title: view === "terminal" ? "切回插件内的气泡对话" : "切到 Hermes 终端界面（可直接在里面输入）",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TerminalIcon, {}), view === "terminal" ? "对话" : "终端"]
							}),
							view === "chat" && sessionId ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "hw-ghost hw-stop",
								disabled: busy,
								onClick: () => void interrupt(),
								style: ghostButtonStyle,
								title: "中断当前执行",
								children: "中断"
							}) : null
						]
					}),
					view === "terminal" && nativeSrc ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: terminalHintStyle,
						children: "Hermes 终端界面：点一下黑色区域即可输入，回车发送，Ctrl+C 中断。"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("iframe", {
						title: "Hermes 终端（TUI）",
						src: nativeSrc,
						style: iframeStyle
					}, nativeSrc)] }) : null,
					view === "terminal" && !nativeOrigin ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: emptyStyle,
						children: state === "online" ? "正在启动终端代理…" : "正在连接本机 Hermes…"
					}) : null,
					view === "chat" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						mountError ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							style: errorStyle,
							children: ["Remote 挂载失败：", mountError]
						}) : null,
						status?.errorMessage ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: status.errorMessage
						}) : null,
						error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: error
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: messagesStyle,
							className: "hw-scroll",
							ref: scrollRef,
							onScroll: () => {
								const el = scrollRef.current;
								if (!el) return;
								stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
							},
							children: [
								messages.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: emptyWrapStyle,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: emptyIconStyle,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HermesIcon, { size: 18 })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: emptyTitleStyle,
											children: sessionId ? "还没有消息" : "选一个 Bot 开始"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: emptyHintStyle,
											children: sessionId ? "在下面输入框里说点什么，Hermes 会在这里回复。" : "左侧列表里选择一个 Bot，历史对话会在这里展开。"
										})
									]
								}) : null,
								blocks.map((block) => block.tools ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToolGroup, { items: block.tools }, block.key) : block.message ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MessageRow, {
									message: block.message,
									canResend: !busy && Boolean(sessionId),
									onResend: (text) => void resend(text)
								}, block.key) : null),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LiveTurn, { live: liveRef.current }),
								visibleRequests.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RequestCard, {
									request: item,
									busy,
									onRespond: (target, result) => void respond(target, result)
								}, String(item.id)))
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: composerStyle,
							className: "hw-composer",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								ref: textareaRef,
								rows: 1,
								value: draft,
								placeholder: sessionId ? "发消息给 Hermes…" : "先选择一个 Bot",
								disabled: !sessionId || busy,
								onChange: (event) => setDraft(event.target.value),
								onKeyDown: (event) => {
									if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
										event.preventDefault();
										send();
									}
								},
								style: textareaStyle
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: !canSend,
								onClick: () => void send(),
								title: "发送（Enter）",
								style: {
									...sendButtonStyle,
									...canSend ? sendButtonReadyStyle : buttonDisabledStyle
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
									viewBox: "0 0 24 24",
									width: "15",
									height: "15",
									fill: "none",
									stroke: "currentColor",
									strokeWidth: "2",
									strokeLinecap: "round",
									strokeLinejoin: "round",
									"aria-hidden": "true",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 19V5M6 11l6-6 6 6" })
								})
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: composerHintStyle,
							children: "Enter 发送 · Shift + Enter 换行"
						})
					] }) : null
				]
			})
		]
	});
}
/** 审批 / 提问卡片。gateway 会一直阻塞到收到回包，所以必须显眼、按钮可点。 */
function RequestCard({ request, busy, onRespond }) {
	if (request.method === "approval") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ApprovalCard, {
		request,
		busy,
		onRespond
	});
	if (request.method === "clarify") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ClarifyCard, {
		request,
		busy,
		onRespond
	});
	return null;
}
const APPROVAL_LABELS = {
	once: "允许一次",
	session: "本会话都允许",
	always: "始终允许",
	deny: "拒绝"
};
function ApprovalCard({ request, busy, onRespond }) {
	const params = request.params;
	const command = typeof params.command === "string" ? params.command : "";
	const description = typeof params.description === "string" ? params.description : "";
	const toolName = typeof params.tool_name === "string" ? params.tool_name : "";
	const choices = Array.isArray(params.choices) ? params.choices.map(String) : ["once", "deny"];
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: requestCardStyle,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: requestHeadStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: requestBadgeStyle,
					children: "需要审批"
				}), toolName ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: requestMetaStyle,
					children: toolName
				}) : null]
			}),
			description ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: requestDescStyle,
				children: description
			}) : null,
			command ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
				style: requestCommandStyle,
				children: command
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: requestActionsStyle,
				children: choices.map((choice) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: busy,
					onClick: () => onRespond(request, { choice }),
					style: {
						...requestButtonStyle,
						...choice === "deny" ? requestButtonDangerStyle : {}
					},
					children: APPROVAL_LABELS[choice] ?? choice
				}, choice))
			})
		]
	});
}
/** clarify：1-5 个问题，可能带选项，也可能是开放输入。 */
function ClarifyCard({ request, busy, onRespond }) {
	const questions = (Array.isArray(request.params.questions) ? request.params.questions : []).map((item) => {
		const row = item ?? {};
		return {
			qid: String(row.qid ?? row.id ?? ""),
			question: String(row.question ?? row.text ?? ""),
			choices: Array.isArray(row.choices) && row.choices.length ? row.choices.map(String) : void 0,
			multiSelect: row.multi_select === true
		};
	});
	const [answers, setAnswers] = (0, react.useState)({});
	const toggle = (question, choice) => {
		setAnswers((previous) => {
			if (!question.multiSelect) return {
				...previous,
				[question.qid]: choice
			};
			const selected = (previous[question.qid] ?? "").split("、").filter(Boolean);
			const next = selected.includes(choice) ? selected.filter((item) => item !== choice) : [...selected, choice];
			return {
				...previous,
				[question.qid]: next.join("、")
			};
		});
	};
	const submit = () => {
		const payload = {};
		for (const question of questions) {
			const value = (answers[question.qid] ?? "").trim();
			payload[question.qid] = value ? value : null;
		}
		onRespond(request, {
			answers: payload,
			outcome: "submitted"
		});
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: requestCardStyle,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: requestHeadStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: requestBadgeStyle,
					children: "需要你的回答"
				}), questions.length > 1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					style: requestMetaStyle,
					children: [questions.length, " 个问题"]
				}) : null]
			}),
			questions.map((question) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: clarifyBlockStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: requestDescStyle,
					children: question.question
				}), question.choices ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: clarifyChoicesStyle,
					children: question.choices.map((choice) => {
						const active = question.multiSelect ? (answers[question.qid] ?? "").split("、").includes(choice) : answers[question.qid] === choice;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							disabled: busy,
							onClick: () => toggle(question, choice),
							style: {
								...clarifyChoiceStyle,
								...active ? clarifyChoiceActiveStyle : {}
							},
							children: choice
						}, choice);
					})
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					type: "text",
					value: answers[question.qid] ?? "",
					disabled: busy,
					onChange: (event) => setAnswers((previous) => ({
						...previous,
						[question.qid]: event.target.value
					})),
					onKeyDown: (event) => {
						if (event.key === "Enter" && !event.nativeEvent.isComposing) submit();
					},
					placeholder: "输入回答…",
					style: clarifyInputStyle
				})]
			}, question.qid)),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: requestActionsStyle,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: busy,
					onClick: submit,
					style: {
						...requestButtonStyle,
						...requestButtonPrimaryStyle
					},
					children: "提交"
				})
			})
		]
	});
}
/** 流式草稿区：文字段与工具行按到达顺序排，末尾带闪烁光标。
*  只在这一轮还没落库时显示；message.complete 之后由真实历史接管。 */
function LiveTurn({ live }) {
	if (!live.active && live.blocks.length === 0) return null;
	const lastIndex = live.blocks.length - 1;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: liveWrapStyle,
		children: [live.blocks.map((block, index) => block.kind === "text" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "hw-md",
			style: assistantTextStyle,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MarkdownBlock, { text: block.text }), live.active && index === lastIndex ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "hw-caret" }) : null]
		}, index) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: liveToolRowStyle,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: block.status === "running" ? "hw-live-dot" : void 0,
					style: {
						...liveToolDotStyle,
						...block.status === "running" ? liveToolDotRunStyle : {}
					}
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: toolNameStyle,
					children: block.name
				}),
				block.summary ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: toolSummaryStyle,
					children: block.summary
				}) : null,
				block.status === "running" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: liveToolStateStyle,
					children: "运行中"
				}) : null
			]
		}, index)), live.active && live.blocks.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: typingRowStyle,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "hw-typing",
				style: typingDotsStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {})
				]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: typingTextStyle,
				children: "Hermes 正在处理"
			})]
		}) : null]
	});
}
/** 原生聊天流：用户消息是浅灰左气泡、助手是裸文本、工具调用折叠成一行。
*  每条消息带轻量操作：复制；用户消息额外支持「重发」。 */
function MessageRow({ message, onResend, canResend }) {
	const [copied, setCopied] = (0, react.useState)(false);
	const copy = () => {
		const text = message.text || "";
		navigator.clipboard?.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		}, () => void 0);
	};
	if (message.role === "assistant" && !message.text.trim()) return null;
	const isUser = message.role === "user";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: "hw-row",
		style: isUser ? userRowStyle : assistantRowStyle,
		"data-copied": copied ? "true" : "false",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: isUser ? userStackStyle : assistantStackStyle,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: isUser ? userBubbleStyle : assistantTextStyle,
				className: isUser ? void 0 : "hw-md",
				children: isUser ? message.text || "（空消息）" : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MarkdownBlock, { text: message.text || "（空消息）" })
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "hw-action",
				style: isUser ? userActionRowStyle : assistantActionRowStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: copy,
					style: actionButtonStyle,
					children: copied ? "已复制" : "复制"
				}), isUser && canResend && message.text ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: () => onResend?.(message.text),
					style: actionButtonStyle,
					children: "重发"
				}) : null]
			})]
		})
	});
}
/** 一段「中间过程」压成一行摘要，点开才展开成步骤列表。
*  折叠态是一枚有边框的胶囊（可点、有 hover），展开后按序号竖排，层级比横排胶囊清楚。 */
function ToolGroup({ items }) {
	const [open, setOpen] = (0, react.useState)(false);
	const details = items.map((item) => ({
		id: item.id,
		...toolDetail(item.text, item.toolName)
	}));
	const single = details.length === 1 ? details[0] : null;
	const names = [...new Set(details.map((item) => item.name))].filter((name) => name !== FALLBACK_TOOL_NAME).slice(0, 3);
	const label = single ? single.name === FALLBACK_TOOL_NAME ? "1 个步骤" : single.name : `${items.length} 个步骤`;
	const failed = details.some((item) => !item.ok);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: toolGroupStyle,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			className: "hw-tool-toggle",
			onClick: () => setOpen((value) => !value),
			style: toolToggleStyle,
			title: open ? "收起中间步骤" : "展开中间步骤",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						...toolGlyphStyle,
						...failed ? toolGlyphFailStyle : {}
					},
					children: failed ? "!" : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SparkIcon, {})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: toolLabelStyle,
					children: label
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: toolMetaStyle,
					children: single ? single.summary : names.join(" · ")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						...toolChevronStyle,
						transform: open ? "rotate(90deg)" : "none"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChevronIcon, {})
				})
			]
		}), open ? single ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
			style: toolPreStyle,
			children: single.pretty
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: toolStepsStyle,
			children: details.map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToolStep, {
				index,
				detail: item
			}, item.id))
		}) : null]
	});
}
/** 单个步骤：序号 + 工具名 + 结果摘要，点开看原始 JSON。 */
function ToolStep({ index, detail }) {
	const [open, setOpen] = (0, react.useState)(false);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: toolStepWrapStyle,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			className: "hw-step",
			onClick: () => setOpen((value) => !value),
			style: toolStepButtonStyle,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: toolStepIndexStyle,
					children: String(index + 1).padStart(2, "0")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: toolNameStyle,
					children: detail.name
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: toolSummaryStyle,
					children: detail.summary
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
					...toolDotStyle,
					...detail.ok ? {} : toolDotFailStyle
				} })
			]
		}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
			style: toolPreStyle,
			children: detail.pretty
		}) : null]
	});
}
/** 工具名兜底值：宿主未透传 tool_name、JSON 里也没有可用字段时的占位。 */
const FALLBACK_TOOL_NAME = "工具调用";
/** 工具消息通常是 JSON；抽出名字、状态与一句话摘要，原始载荷留给展开。 */
function toolDetail(text, toolName) {
	let parsed = null;
	try {
		const value = JSON.parse(text);
		if (value && typeof value === "object") parsed = value;
	} catch {
		parsed = null;
	}
	if (!parsed) return {
		name: toolName || FALLBACK_TOOL_NAME,
		summary: text.replace(/\s+/g, " ").slice(0, 60),
		pretty: text,
		ok: true
	};
	const name = toolName || String(parsed.name ?? parsed.tool ?? parsed.tool_name ?? parsed.type ?? FALLBACK_TOOL_NAME);
	const failed = Boolean(parsed.error) || parsed.ok === false || parsed.status === "error";
	const rawSummary = parsed.message ?? parsed.summary ?? parsed.action ?? (typeof parsed.output === "string" ? parsed.output.split("\n")[0] : void 0) ?? parsed.arguments ?? parsed.args;
	const summary = typeof rawSummary === "string" ? rawSummary.replace(/\s+/g, " ").slice(0, 70) : rawSummary && typeof rawSummary === "object" ? Object.keys(rawSummary).slice(0, 4).join(" · ") : "";
	let pretty = text;
	try {
		pretty = JSON.stringify(parsed, null, 2);
	} catch {
		pretty = text;
	}
	return {
		name,
		summary,
		pretty,
		ok: !failed
	};
}
/** 行内标记：**粗体** 与 `代码`。 */
function inlineParts(text) {
	const parts = [];
	const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
	let cursor = 0;
	let key = 0;
	let match;
	while ((match = pattern.exec(text)) !== null) {
		if (match.index > cursor) parts.push(text.slice(cursor, match.index));
		const token = match[0];
		if (token.startsWith("**")) parts.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
			style: mdStrongStyle,
			children: token.slice(2, -2)
		}, key++));
		else parts.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
			style: mdCodeStyle,
			children: token.slice(1, -1)
		}, key++));
		cursor = match.index + token.length;
	}
	if (cursor < text.length) parts.push(text.slice(cursor));
	return parts;
}
/** 轻量 Markdown：标题 / 列表 / 代码块 / 段落，足够还原 Hermes Bot 的排版。
*  不引入依赖，遇到不认识的语法按普通文本处理。 */
function MarkdownBlock({ text }) {
	const nodes = [];
	let paragraph = [];
	let list = [];
	let listOrdered = false;
	let code = null;
	let key = 0;
	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		nodes.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			style: mdParagraphStyle,
			children: inlineParts(paragraph.join("\n"))
		}, key++));
		paragraph = [];
	};
	const flushList = () => {
		if (list.length === 0) return;
		const items = list.map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
			style: mdListItemStyle,
			children: inlineParts(item)
		}, index));
		nodes.push(listOrdered ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
			style: mdListStyle,
			children: items
		}, key++) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
			style: mdListStyle,
			children: items
		}, key++));
		list = [];
	};
	for (const line of text.split("\n")) {
		if (line.trim().startsWith("```")) {
			if (code === null) {
				flushParagraph();
				flushList();
				code = [];
			} else {
				nodes.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
					style: mdPreStyle,
					children: code.join("\n")
				}, key++));
				code = null;
			}
			continue;
		}
		if (code !== null) {
			code.push(line);
			continue;
		}
		if (!line.trim()) {
			flushParagraph();
			flushList();
			continue;
		}
		const heading = /^\s{0,3}(#{1,6})\s*(.+)$/.exec(line);
		if (heading) {
			flushParagraph();
			flushList();
			nodes.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: mdHeadingStyle,
				children: inlineParts(heading[2])
			}, key++));
			continue;
		}
		const unordered = /^\s*[-*]\s+(.*)$/.exec(line);
		if (unordered) {
			flushParagraph();
			if (list.length > 0 && listOrdered) flushList();
			listOrdered = false;
			list.push(unordered[1]);
			continue;
		}
		const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		if (ordered) {
			flushParagraph();
			if (list.length > 0 && !listOrdered) flushList();
			listOrdered = true;
			list.push(ordered[1]);
			continue;
		}
		flushList();
		paragraph.push(line);
	}
	flushParagraph();
	flushList();
	if (code !== null) nodes.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
		style: mdPreStyle,
		children: code.join("\n")
	}, key++));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: nodes });
}
/** 交互态（hover / 焦点 / 滚动条 / 动画）内联样式表达不了，统一挂一份前缀化样式表。
*  所有选择器都以 .hw- 开头；即使宿主不加载它，也只是没有 hover 反馈，不影响可用性。 */
const PANEL_CSS = `
.hw-scroll{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent) transparent}
.hw-scroll::-webkit-scrollbar{width:9px;height:9px}
.hw-scroll::-webkit-scrollbar-track{background:transparent}
.hw-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);border-radius:999px;border:3px solid transparent;background-clip:content-box}
.hw-scroll::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 28%,transparent);background-clip:content-box}
.hw-bot{transition:background .12s ease}
.hw-bot:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.hw-ghost{transition:color .12s ease,background .12s ease}
.hw-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.hw-stop:hover:not(:disabled){color:var(--dsw-alias-label-danger,#c0392b);background:color-mix(in srgb,var(--dsw-alias-label-danger,#c0392b) 10%,transparent)}
.hw-tool-toggle{transition:background .12s ease,border-color .12s ease}
.hw-tool-toggle:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.hw-step{transition:background .12s ease}
.hw-step:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}
.hw-composer{transition:border-color .16s ease,background .16s ease}
.hw-composer:focus-within{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.hw-composer textarea::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-primary) 34%,transparent)}
.hw-md>*:last-child{margin-bottom:0!important}
.hw-action{opacity:0;transition:opacity .12s ease}
.hw-row:hover .hw-action,.hw-row[data-copied='true'] .hw-action{opacity:1}
.hw-typing span{display:inline-block;width:4px;height:4px;border-radius:999px;background:currentColor;margin-right:3px;animation:hw-pulse 1.2s infinite ease-in-out}
.hw-typing span:nth-child(2){animation-delay:.15s}
.hw-typing span:nth-child(3){animation-delay:.3s}
@keyframes hw-pulse{0%,80%,100%{opacity:.22;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}
.hw-caret{display:inline-block;width:2px;height:13px;margin-left:2px;border-radius:1px;background:currentColor;vertical-align:-2px;animation:hw-caret 1.05s steps(1,end) infinite}
@keyframes hw-caret{0%,49%{opacity:1}50%,100%{opacity:0}}
.hw-live-dot{animation:hw-pulse 1.1s infinite ease-in-out}
`;
const pageStyle = {
	display: "flex",
	height: "100%",
	overflow: "hidden",
	boxSizing: "border-box",
	background: "var(--dsw-alias-bg-primary)",
	color: "var(--dsw-alias-label-primary)"
};
const sidebarStyle = {
	width: 204,
	flexShrink: 0,
	display: "flex",
	flexDirection: "column",
	gap: 1,
	padding: "12px 8px",
	borderRight: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)",
	overflowY: "auto",
	boxSizing: "border-box"
};
const sidebarTitleStyle = {
	fontSize: 10,
	letterSpacing: "0.12em",
	textTransform: "uppercase",
	color: "var(--dsw-alias-label-secondary)",
	padding: "6px 10px 10px"
};
const botListStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 2
};
const sidebarEmptyStyle = {
	padding: "4px 10px",
	color: "var(--dsw-alias-label-secondary)",
	fontSize: 12
};
const botItemStyle = {
	position: "relative",
	display: "flex",
	alignItems: "center",
	gap: 9,
	width: "100%",
	padding: "7px 8px",
	border: "none",
	borderRadius: 8,
	background: "transparent",
	color: "inherit",
	textAlign: "left",
	cursor: "pointer",
	overflow: "hidden"
};
const botItemActiveStyle = { background: "color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)" };
/** 选中态靠左侧 2px 竖条点明，比整块深色更克制。 */
const botActiveBarStyle = {
	position: "absolute",
	left: 0,
	top: 7,
	bottom: 7,
	width: 2,
	borderRadius: 999,
	background: "var(--dsw-alias-label-primary)"
};
const avatarStyle = {
	width: 24,
	height: 24,
	borderRadius: 7,
	flexShrink: 0,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)",
	color: "var(--dsw-alias-label-secondary)",
	fontSize: 10.5,
	fontWeight: 600
};
const avatarActiveStyle = {
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)",
	color: "var(--dsw-alias-label-primary)"
};
const botTextStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 1,
	minWidth: 0,
	flex: 1
};
const botNameStyle = {
	fontSize: 12.5,
	fontWeight: 500,
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap"
};
const botPreviewStyle = {
	fontSize: 11,
	color: "var(--dsw-alias-label-secondary)",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap"
};
const chatPaneStyle = {
	flex: 1,
	minWidth: 0,
	display: "flex",
	flexDirection: "column",
	height: "100%"
};
const terminalHintStyle = {
	flexShrink: 0,
	padding: "6px 22px 0",
	fontSize: 11.5,
	color: "var(--dsw-alias-label-secondary)"
};
const iframeStyle = {
	flex: 1,
	width: "100%",
	border: "none",
	minHeight: 0,
	background: "transparent"
};
const chatHeaderStyle = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	flexShrink: 0,
	padding: "12px 22px",
	borderBottom: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)"
};
const headerAvatarStyle = {
	width: 21,
	height: 21,
	borderRadius: 6,
	flexShrink: 0,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent)",
	color: "var(--dsw-alias-label-primary)",
	fontSize: 10,
	fontWeight: 600
};
const chatTitleStyle = {
	fontSize: 13,
	fontWeight: 600,
	letterSpacing: "-0.01em"
};
/** 模型徽标：等宽小字 + 弱边框，模仿 AI 原生界面里的 model picker（此处只读展示）。 */
const modelChipStyle = {
	fontSize: 10.5,
	padding: "1px 7px",
	borderRadius: 6,
	border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)",
	color: "var(--dsw-alias-label-secondary)",
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
	whiteSpace: "nowrap"
};
const dotStyle = {
	width: 6,
	height: 6,
	borderRadius: 999,
	flexShrink: 0
};
const dotOkStyle = { background: "var(--dsw-alias-label-success, #22a06b)" };
const dotWarnStyle = { background: "var(--dsw-alias-label-secondary)" };
/** 连接状态跟绿点绑在一起，和右侧的操作按钮用竖线隔开。 */
const statusWrapStyle = {
	display: "inline-flex",
	alignItems: "center",
	gap: 5,
	fontSize: 10.5,
	color: "var(--dsw-alias-label-secondary)",
	whiteSpace: "nowrap"
};
const headerDividerStyle = {
	width: 1,
	height: 12,
	flexShrink: 0,
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)"
};
/** 头部只留文字型按钮，避免一堆描边胶囊把标题区挤满。 */
const ghostButtonStyle = {
	display: "inline-flex",
	alignItems: "center",
	gap: 5,
	padding: "3px 7px",
	borderRadius: 6,
	border: "none",
	background: "transparent",
	color: "var(--dsw-alias-label-secondary)",
	cursor: "pointer",
	fontSize: 11
};
const errorStyle = {
	margin: "8px 22px 0",
	paddingLeft: 8,
	fontSize: 12,
	color: "var(--dsw-alias-label-danger, #c0392b)",
	borderLeft: "2px solid var(--dsw-alias-label-danger, #c0392b)"
};
const messagesStyle = {
	flex: 1,
	minHeight: 0,
	overflowY: "auto",
	display: "flex",
	flexDirection: "column",
	gap: 18,
	padding: "20px 26px 8px"
};
const userRowStyle = {
	display: "flex",
	justifyContent: "flex-end"
};
const assistantRowStyle = {
	display: "flex",
	justifyContent: "flex-start"
};
const userStackStyle = {
	position: "relative",
	display: "flex",
	flexDirection: "column",
	alignItems: "flex-end",
	maxWidth: "100%"
};
const assistantStackStyle = {
	position: "relative",
	display: "flex",
	flexDirection: "column",
	alignItems: "flex-start",
	maxWidth: "100%"
};
/** 用户消息气泡：只做轻微着色，绝不反色。
*  DSH 主题变量在插件上下文里不稳定（曾出现黑底黑字把内容吞掉），
*  可读性优先：浅色底 + 继承字色，明暗主题都不会翻车。 */
const userBubbleStyle = {
	maxWidth: 480,
	padding: "9px 15px",
	borderRadius: 17,
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)",
	color: "inherit",
	fontSize: 13.5,
	lineHeight: 1.65,
	whiteSpace: "pre-wrap",
	wordBreak: "break-word"
};
const assistantTextStyle = {
	maxWidth: 680,
	fontSize: 14,
	lineHeight: 1.72,
	wordBreak: "break-word"
};
const mdParagraphStyle = {
	margin: "0 0 9px",
	whiteSpace: "pre-wrap",
	wordBreak: "break-word"
};
const mdHeadingStyle = {
	margin: "16px 0 8px",
	fontSize: 14.5,
	fontWeight: 600,
	lineHeight: 1.5
};
const mdListStyle = {
	margin: "0 0 9px",
	paddingLeft: 20
};
const mdListItemStyle = {
	margin: "3px 0",
	lineHeight: 1.7
};
const mdPreStyle = {
	margin: "0 0 12px",
	padding: "10px 12px",
	borderRadius: 8,
	overflow: "auto",
	maxHeight: 320,
	background: "var(--dsw-alias-bg-secondary)",
	color: "var(--dsw-alias-label-primary)",
	fontSize: 12,
	lineHeight: 1.55,
	whiteSpace: "pre-wrap",
	wordBreak: "break-word"
};
const mdStrongStyle = { fontWeight: 600 };
const mdCodeStyle = {
	padding: "1px 5px",
	borderRadius: 4,
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
	fontSize: "0.92em",
	background: "var(--dsw-alias-bg-secondary)"
};
/** 一组工具调用：折叠态是有边框的胶囊行，展开后按序号竖排。
*  marginTop 收一点，让「步骤」视觉上跟着它后面那条回复走。 */
const toolGroupStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 6,
	alignItems: "flex-start",
	marginTop: -2,
	marginBottom: -2,
	maxWidth: "100%"
};
const toolToggleStyle = {
	display: "inline-flex",
	alignItems: "center",
	gap: 7,
	padding: "4px 9px 4px 8px",
	borderRadius: 9,
	border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 11%, transparent)",
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 2.5%, transparent)",
	color: "var(--dsw-alias-label-secondary)",
	cursor: "pointer",
	fontSize: 11.5,
	lineHeight: 1.45,
	textAlign: "left",
	maxWidth: "100%"
};
const toolGlyphStyle = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: 15,
	height: 15,
	borderRadius: 4,
	flexShrink: 0,
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)",
	color: "var(--dsw-alias-label-secondary)",
	fontSize: 9.5,
	fontWeight: 700
};
const toolGlyphFailStyle = {
	background: "color-mix(in srgb, var(--dsw-alias-label-danger, #c0392b) 14%, transparent)",
	color: "var(--dsw-alias-label-danger, #c0392b)"
};
const toolLabelStyle = {
	color: "var(--dsw-alias-label-primary)",
	fontWeight: 500,
	flexShrink: 0
};
const toolMetaStyle = {
	opacity: .7,
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
	maxWidth: 320
};
const toolChevronStyle = {
	display: "inline-flex",
	opacity: .55,
	transition: "transform .14s ease",
	flexShrink: 0
};
const toolStepsStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 1,
	width: "100%",
	maxWidth: 560,
	paddingLeft: 6,
	marginLeft: 6,
	borderLeft: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)"
};
const toolStepWrapStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 4
};
/** 步骤行用 grid 对齐：序号 / 工具名 / 摘要 / 状态点四列，名字长短不一时摘要也不参差。 */
const toolStepButtonStyle = {
	display: "grid",
	gridTemplateColumns: "16px minmax(56px, max-content) 1fr 6px",
	alignItems: "center",
	columnGap: 8,
	padding: "3px 6px",
	width: "100%",
	borderRadius: 6,
	border: "none",
	background: "transparent",
	color: "var(--dsw-alias-label-secondary)",
	cursor: "pointer",
	fontSize: 11.5,
	lineHeight: 1.55,
	textAlign: "left"
};
const toolStepIndexStyle = {
	flexShrink: 0,
	width: 15,
	fontSize: 9.5,
	opacity: .5,
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
};
/** 工具状态不再用红绿点（彩色噪声大），改成中性小方块，失败时才变红。 */
const toolDotStyle = {
	width: 4,
	height: 4,
	borderRadius: 1.5,
	flexShrink: 0,
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 35%, transparent)"
};
const toolDotFailStyle = { background: "var(--dsw-alias-label-danger, #c0392b)" };
const toolSummaryStyle = {
	color: "var(--dsw-alias-label-secondary)",
	opacity: .82,
	minWidth: 0,
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap"
};
/** 操作条贴在气泡下方 20px 的间隙里，用 Canvas 底色盖住底下的文字，不占布局。 */
const actionButtonStyle = {
	border: "none",
	background: "transparent",
	padding: "0 2px",
	cursor: "pointer",
	color: "var(--dsw-alias-label-secondary)",
	fontSize: 10.5
};
const userActionRowStyle = {
	position: "absolute",
	right: 2,
	bottom: -17,
	display: "flex",
	gap: 8,
	padding: "0 4px",
	borderRadius: 5,
	background: "Canvas"
};
const assistantActionRowStyle = {
	position: "absolute",
	left: 2,
	bottom: -17,
	display: "flex",
	gap: 8,
	padding: "0 4px",
	borderRadius: 5,
	background: "Canvas"
};
const toolNameStyle = {
	color: "var(--dsw-alias-label-primary)",
	fontWeight: 500,
	flexShrink: 0
};
const toolPreStyle = {
	margin: 0,
	marginLeft: 12,
	padding: "8px 10px",
	borderRadius: 8,
	maxWidth: "86%",
	background: "var(--dsw-alias-bg-secondary)",
	color: "var(--dsw-alias-label-secondary)",
	fontSize: 11,
	lineHeight: 1.5,
	whiteSpace: "pre-wrap",
	wordBreak: "break-all",
	maxHeight: 260,
	overflow: "auto"
};
const emptyStyle = {
	margin: "auto",
	color: "var(--dsw-alias-label-secondary)",
	fontSize: 12
};
const emptyWrapStyle = {
	margin: "auto",
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	gap: 4,
	paddingBottom: 24,
	maxWidth: 260,
	textAlign: "center"
};
const emptyIconStyle = {
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	width: 34,
	height: 34,
	borderRadius: 10,
	marginBottom: 4,
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)",
	color: "var(--dsw-alias-label-secondary)"
};
const emptyTitleStyle = {
	fontSize: 12.5,
	fontWeight: 500,
	color: "var(--dsw-alias-label-primary)"
};
const emptyHintStyle = {
	fontSize: 11.5,
	lineHeight: 1.6,
	color: "var(--dsw-alias-label-secondary)"
};
const typingRowStyle = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	paddingTop: 2,
	color: "var(--dsw-alias-label-secondary)"
};
/** 流式草稿：和助手正文同样式，但整体左对齐、块之间留一点气口。 */
const liveWrapStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 10,
	alignItems: "flex-start",
	maxWidth: "100%"
};
const liveToolRowStyle = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	padding: "4px 9px",
	borderRadius: 8,
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 3.5%, transparent)",
	border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent)",
	fontSize: 11.5,
	maxWidth: "100%"
};
const liveToolDotStyle = {
	width: 5,
	height: 5,
	borderRadius: 999,
	flexShrink: 0,
	background: "var(--dsw-alias-label-success, #22a06b)"
};
const liveToolDotRunStyle = { background: "var(--dsw-alias-label-secondary)" };
const liveToolStateStyle = {
	fontSize: 10,
	opacity: .55,
	flexShrink: 0
};
const typingDotsStyle = {
	display: "inline-flex",
	alignItems: "center",
	paddingLeft: 2
};
const typingTextStyle = {
	fontSize: 11.5,
	opacity: .8
};
/** 输入区是一个整块圆角盒子：输入区无边框，发送键在盒子内部右下，参考 AI 原生 composer。 */
const composerStyle = {
	display: "flex",
	gap: 8,
	alignItems: "flex-end",
	flexShrink: 0,
	margin: "4px 24px 0",
	padding: "7px 7px 7px 14px",
	borderRadius: 16,
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)",
	border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)"
};
const textareaStyle = {
	flex: 1,
	padding: "6px 0",
	border: "none",
	background: "transparent",
	color: "inherit",
	fontSize: 13.5,
	lineHeight: 1.6,
	outline: "none",
	resize: "none",
	maxHeight: 132,
	fontFamily: "inherit",
	minHeight: 21
};
const sendButtonStyle = {
	width: 30,
	height: 30,
	borderRadius: 10,
	flexShrink: 0,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)",
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)",
	color: "var(--dsw-alias-label-secondary)",
	cursor: "pointer",
	transition: "background .12s ease, color .12s ease, border-color .12s ease"
};
/** 有内容可发时才把发送键提亮；用中性色差而不是主色反白，避免深色主题下白字看不见。 */
const sendButtonReadyStyle = {
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)",
	borderColor: "color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent)",
	color: "var(--dsw-alias-label-primary)"
};
const buttonDisabledStyle = {
	opacity: .4,
	cursor: "default"
};
/** 审批 / 提问卡片：像一条等待操作的浮层卡片，和正文拉开层次。 */
const requestCardStyle = {
	alignSelf: "stretch",
	display: "flex",
	flexDirection: "column",
	gap: 9,
	padding: "12px 13px",
	borderRadius: 12,
	maxWidth: 580,
	border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 15%, transparent)",
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)"
};
const requestHeadStyle = {
	display: "flex",
	alignItems: "center",
	gap: 8
};
const requestBadgeStyle = {
	fontSize: 10,
	letterSpacing: "0.04em",
	padding: "2px 7px",
	borderRadius: 5,
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)",
	color: "var(--dsw-alias-label-primary)"
};
const requestMetaStyle = {
	fontSize: 10.5,
	color: "var(--dsw-alias-label-secondary)"
};
const requestDescStyle = {
	fontSize: 12.5,
	lineHeight: 1.6,
	color: "var(--dsw-alias-label-primary)"
};
const requestCommandStyle = {
	margin: 0,
	padding: "8px 10px",
	borderRadius: 8,
	maxHeight: 160,
	overflow: "auto",
	background: "var(--dsw-alias-bg-secondary)",
	color: "var(--dsw-alias-label-primary)",
	fontSize: 11.5,
	lineHeight: 1.55,
	whiteSpace: "pre-wrap",
	wordBreak: "break-all",
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
};
const requestActionsStyle = {
	display: "flex",
	flexWrap: "wrap",
	gap: 7
};
const requestButtonStyle = {
	padding: "5px 11px",
	borderRadius: 7,
	cursor: "pointer",
	fontSize: 11.5,
	border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent)",
	background: "transparent",
	color: "var(--dsw-alias-label-primary)"
};
const requestButtonDangerStyle = {
	color: "var(--dsw-alias-label-danger, #c0392b)",
	borderColor: "color-mix(in srgb, var(--dsw-alias-label-danger, #c0392b) 35%, transparent)"
};
const requestButtonPrimaryStyle = {
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)",
	borderColor: "color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent)"
};
const clarifyBlockStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 6
};
const clarifyChoicesStyle = {
	display: "flex",
	flexWrap: "wrap",
	gap: 6
};
const clarifyChoiceStyle = {
	padding: "4px 10px",
	borderRadius: 999,
	cursor: "pointer",
	fontSize: 11.5,
	border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)",
	background: "transparent",
	color: "var(--dsw-alias-label-secondary)"
};
const clarifyChoiceActiveStyle = {
	background: "color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)",
	borderColor: "color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent)",
	color: "var(--dsw-alias-label-primary)"
};
const clarifyInputStyle = {
	padding: "6px 9px",
	borderRadius: 7,
	fontSize: 12.5,
	border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)",
	background: "transparent",
	color: "inherit",
	outline: "none"
};
const composerHintStyle = {
	flexShrink: 0,
	margin: "6px 30px 14px",
	textAlign: "right",
	fontSize: 10,
	letterSpacing: "0.01em",
	color: "var(--dsw-alias-label-secondary)",
	opacity: .45
};

//#endregion
exports.PANEL_ID = PANEL_ID;
exports.apply = apply;
exports.inject = inject;
return module.exports; } });