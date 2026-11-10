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
/** Client 侧 descriptor 必须与 Host 侧 SRC 从方法签名派生的结果一致：
*  形参名即 wire 名、codec 为 src-json；Host 方法未声明 signal，因此不能带 cancellation
*  （否则唯一实参会被当成 callerSignal 传给 AbortSignal.any，报转换错误）。 */
function remoteMethod(method, parameterNames = []) {
	return {
		id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}`,
		service: REMOTE_NAMESPACE,
		namespace: REMOTE_NAMESPACE,
		method,
		invocation: { kind: "direct" },
		parameters: parameterNames.map((name) => ({
			name,
			wire: name,
			source: "json",
			codec: { mode: "src-json" }
		})),
		result: { mode: "src-json" }
	};
}
const TYPERT_REMOTE = {
	package: PACKAGE_NAME,
	descriptors: [
		remoteMethod("getConnectionStatus"),
		remoteMethod("getBotRoster"),
		remoteMethod("resumeSession", ["request"]),
		remoteMethod("submitPrompt", ["request"]),
		remoteMethod("interruptSession", ["request"]),
		remoteMethod("getEvents")
	]
};
const inject = [
	"slots",
	"layout",
	"remote"
];
async function apply(ctx) {
	try {
		await ctx.remote.$mount(TYPERT_REMOTE);
	} catch (error) {
		ctx.logger?.error?.("hermes-workspace: failed to mount Remote namespace: %o", error);
		throw error;
	}
	ctx.inject([`remote.${REMOTE_NAMESPACE}`], (child) => registerWorkspace(child));
}
function unwrap(result) {
	if (result.ok) return result.value;
	throw result.error;
}
function registerWorkspace(ctx) {
	const remote = ctx.remote.hermesWorkspace;
	const api = {
		getConnectionStatus: async () => {
			if (!remote?.getConnectionStatus) throw new Error("Hermes Workspace 服务尚未就绪");
			return unwrap(await remote.getConnectionStatus());
		},
		getBotRoster: async () => {
			if (!remote?.getBotRoster) throw new Error("Hermes Workspace 服务尚未就绪");
			return unwrap(await remote.getBotRoster());
		},
		resumeSession: async (request) => {
			if (!remote?.resumeSession) throw new Error("Hermes Workspace 服务尚未就绪");
			return unwrap(await remote.resumeSession(request));
		},
		submitPrompt: async (request) => {
			if (!remote?.submitPrompt) throw new Error("Hermes Workspace 服务尚未就绪");
			return unwrap(await remote.submitPrompt(request));
		},
		interruptSession: async (request) => {
			if (!remote?.interruptSession) throw new Error("Hermes Workspace 服务尚未就绪");
			return unwrap(await remote.interruptSession(request));
		},
		getEvents: async () => {
			if (!remote?.getEvents) throw new Error("Hermes Workspace 服务尚未就绪");
			return unwrap(await remote.getEvents());
		}
	};
	ctx.slots.inject("main", () => ctx.slots.register({
		name: "main",
		key: PANEL_ID,
		inject: () => ({ api })
	}, HermesChatPanel));
	ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
		name: "sidebar.panellist",
		id: PANEL_ID,
		order: 18,
		label: "Hermes"
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
function stateLabel(state) {
	if (state === "online") return "已连接";
	if (state === "connecting") return "连接中";
	if (state === "error") return "连接失败";
	return "未连接";
}
function HermesChatPanel(props) {
	const api = props.api;
	const [status, setStatus] = (0, react.useState)(null);
	const [profiles, setProfiles] = (0, react.useState)([]);
	const [sessionId, setSessionId] = (0, react.useState)(null);
	const [messages, setMessages] = (0, react.useState)([]);
	const [events, setEvents] = (0, react.useState)([]);
	const [draft, setDraft] = (0, react.useState)("");
	const [error, setError] = (0, react.useState)(null);
	const [busy, setBusy] = (0, react.useState)(false);
	const sessionRef = (0, react.useRef)(null);
	const generationRef = (0, react.useRef)(void 0);
	const lastRefreshRef = (0, react.useRef)(0);
	const previousState = (0, react.useRef)("disconnected");
	/** resume 同时提供历史与执行代次；后者是 interrupt / steer 的必需参数。 */
	function applyResume(resumed) {
		sessionRef.current = resumed.sessionId;
		generationRef.current = resumed.executionGeneration;
		setSessionId(resumed.sessionId);
		setMessages(resumed.messages);
	}
	async function refreshHistory() {
		if (!api || !sessionRef.current) return;
		try {
			applyResume(await api.resumeSession({ sessionId: sessionRef.current }));
		} catch {}
	}
	async function loadRoster() {
		if (!api) return;
		const roster = await api.getBotRoster();
		setProfiles(roster.profiles);
		const preferred = roster.profiles.find((row) => row.canonicalSessionId);
		if (preferred?.canonicalSessionId && sessionRef.current === null) applyResume(await api.resumeSession({ sessionId: preferred.canonicalSessionId }));
	}
	async function selectBot(row) {
		if (!api || !row.canonicalSessionId) return;
		setBusy(true);
		setError(null);
		try {
			applyResume(await api.resumeSession({ sessionId: row.canonicalSessionId }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}
	async function send() {
		if (!api || !sessionId || !draft.trim()) return;
		setBusy(true);
		setError(null);
		try {
			const result = await api.submitPrompt({
				sessionId,
				text: draft.trim()
			});
			if (!result.accepted) setError(result.errorMessage ?? "消息未被接受");
			else {
				setDraft("");
				window.setTimeout(() => void refreshHistory(), 1800);
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
				executionGeneration: generationRef.current
			});
			if (!result.accepted) setError(result.errorMessage ?? "中断失败");
			else window.setTimeout(() => void refreshHistory(), 800);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}
	(0, react.useEffect)(() => {
		if (!api) return;
		let cancelled = false;
		(async () => {
			try {
				await loadRoster();
			} catch (cause) {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			}
		})();
		const timer = setInterval(() => {
			(async () => {
				try {
					const next = await api.getConnectionStatus();
					if (cancelled) return;
					setStatus(next);
					const recovered = previousState.current !== "online" && next.state === "online";
					previousState.current = next.state;
					if (recovered && sessionRef.current) {
						const resumed = await api.resumeSession({ sessionId: sessionRef.current });
						if (!cancelled) applyResume(resumed);
					}
					const page = await api.getEvents();
					if (!cancelled && page.events.length) {
						setEvents((previous) => [...previous, ...page.events].slice(-12));
						if (page.events.some((item) => /message|turn|prompt|tool|assistant|complete/i.test(String(item.type))) && sessionRef.current && Date.now() - lastRefreshRef.current > 2500) {
							lastRefreshRef.current = Date.now();
							const resumed = await api.resumeSession({ sessionId: sessionRef.current });
							if (!cancelled) applyResume(resumed);
						}
					}
				} catch {}
			})();
		}, 1500);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [api]);
	const state = status?.state ?? "disconnected";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: pageStyle,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: headerStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: kickerStyle,
					children: "Hermes · Gateway"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
					style: titleStyle,
					children: "Bot 对话"
				})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						...badgeStyle,
						...state === "online" ? badgeOkStyle : badgeWarnStyle
					},
					children: stateLabel(state)
				})]
			}),
			status?.errorMessage ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: errorStyle,
				children: status.errorMessage
			}) : null,
			error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: errorStyle,
				children: error
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: rosterStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: sectionLabelStyle,
					children: "Bot 列表"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: rowStyle,
					children: [profiles.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: mutedStyle,
						children: "尚未读取到 Bot，等待 Gateway 连接…"
					}) : null, profiles.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						disabled: busy || !row.canonicalSessionId,
						onClick: () => void selectBot(row),
						style: {
							...botButtonStyle,
							...row.canonicalSessionId === sessionId ? botActiveStyle : {}
						},
						children: [row.displayName || row.name, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: botMetaStyle,
							children: row.canonicalSessionId ? " · 可恢复会话" : " · 无 canonical 会话"
						})]
					}, row.name))]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: chatAreaStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: sectionLabelStyle,
					children: [
						"会话历史",
						sessionId ? ` · ${sessionId.slice(0, 18)}…` : "",
						" · ",
						messages.length,
						" 条"
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: messagesStyle,
					children: [messages.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: mutedStyle,
						children: "选择 Bot 后恢复其 canonical Bot Chat。"
					}) : null, messages.map((message) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...bubbleStyle,
							...message.role === "user" ? userBubbleStyle : {}
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: roleStyle,
							children: message.role
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: textStyle,
							children: message.text || "（无文本内容）"
						})]
					}, message.id))]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: composerStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "text",
						value: draft,
						placeholder: sessionId ? "输入消息…" : "先选择一个 Bot",
						disabled: !sessionId || busy,
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter") send();
						},
						style: inputStyle
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						disabled: !sessionId || busy || !draft.trim(),
						onClick: () => void send(),
						style: buttonStyle,
						children: "发送"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						disabled: !sessionId || busy,
						onClick: () => void interrupt(),
						style: buttonStyle,
						children: "中断"
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: eventsStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: sectionLabelStyle,
					children: "最近事件"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: mutedStyle,
					children: events.length ? events.slice(-4).map((item) => item.type).join(" · ") : "暂无"
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: mutedStyle,
				children: "会话与记忆由 Hermes Gateway 持有；发送消息会写入同一条 canonical Bot Chat。"
			})
		]
	});
}
const pageStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 12,
	height: "100%",
	padding: 24,
	boxSizing: "border-box",
	background: "var(--dsw-alias-bg-primary)",
	color: "var(--dsw-alias-label-primary)",
	overflow: "auto"
};
const headerStyle = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between"
};
const kickerStyle = {
	fontSize: 12,
	color: "var(--dsw-alias-label-secondary)",
	letterSpacing: "0.04em",
	textTransform: "uppercase"
};
const titleStyle = {
	margin: "2px 0 0",
	fontSize: 22,
	fontWeight: 600
};
const sectionLabelStyle = {
	fontSize: 12,
	color: "var(--dsw-alias-label-secondary)"
};
const mutedStyle = {
	margin: 0,
	color: "var(--dsw-alias-label-secondary)",
	fontSize: 12
};
const errorStyle = {
	margin: 0,
	color: "var(--dsw-alias-label-danger, #c0392b)",
	fontSize: 12
};
const badgeStyle = {
	fontSize: 12,
	padding: "3px 10px",
	borderRadius: 999
};
const badgeOkStyle = {
	background: "var(--dsw-alias-bg-success, #e6f4ea)",
	color: "var(--dsw-alias-label-success, #1e7e34)"
};
const badgeWarnStyle = {
	background: "var(--dsw-alias-bg-secondary)",
	color: "var(--dsw-alias-label-secondary)"
};
const rosterStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 8
};
const rowStyle = {
	display: "flex",
	gap: 8,
	flexWrap: "wrap",
	alignItems: "center"
};
const botButtonStyle = {
	padding: "7px 12px",
	borderRadius: 8,
	border: "1px solid var(--dsw-alias-border-primary)",
	background: "var(--dsw-alias-bg-secondary)",
	color: "inherit",
	cursor: "pointer",
	fontSize: 13
};
const botActiveStyle = { borderColor: "var(--dsw-alias-label-primary)" };
const botMetaStyle = {
	fontSize: 11,
	color: "var(--dsw-alias-label-secondary)"
};
const chatAreaStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 8,
	flex: 1,
	minHeight: 180
};
const messagesStyle = {
	flex: 1,
	overflow: "auto",
	display: "flex",
	flexDirection: "column",
	gap: 8,
	padding: 12,
	borderRadius: 8,
	background: "var(--dsw-alias-bg-secondary)"
};
const bubbleStyle = {
	padding: "8px 10px",
	borderRadius: 8,
	background: "var(--dsw-alias-bg-primary)",
	border: "0.5px solid var(--dsw-alias-border-primary)",
	maxWidth: "92%",
	alignSelf: "flex-start"
};
const userBubbleStyle = { alignSelf: "flex-end" };
const roleStyle = {
	fontSize: 11,
	color: "var(--dsw-alias-label-secondary)",
	marginBottom: 4
};
const textStyle = {
	fontSize: 13,
	lineHeight: 1.55,
	whiteSpace: "pre-wrap",
	wordBreak: "break-word"
};
const composerStyle = {
	display: "flex",
	gap: 8
};
const inputStyle = {
	flex: 1,
	padding: "8px 10px",
	borderRadius: 8,
	border: "1px solid var(--dsw-alias-border-primary)",
	background: "var(--dsw-alias-bg-secondary)",
	color: "inherit",
	fontSize: 13
};
const buttonStyle = {
	padding: "8px 12px",
	borderRadius: 8,
	border: "1px solid var(--dsw-alias-border-primary)",
	background: "var(--dsw-alias-bg-secondary)",
	color: "inherit",
	cursor: "pointer",
	fontSize: 13
};
const eventsStyle = {
	display: "flex",
	gap: 10,
	alignItems: "center",
	flexWrap: "wrap"
};

//#endregion
exports.PANEL_ID = PANEL_ID;
exports.apply = apply;
exports.inject = inject;
return module.exports; } });