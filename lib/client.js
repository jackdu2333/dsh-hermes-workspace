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
const jsonCodec = () => ({
	mode: "strict",
	typeSymbol: `${PACKAGE_NAME}#json`,
	create: () => ({
		parse: (value) => value,
		safeParse: (value) => ({
			success: true,
			data: value
		})
	})
});
function remoteMethod(method, hasParams = false) {
	return {
		id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}`,
		service: REMOTE_NAMESPACE,
		namespace: REMOTE_NAMESPACE,
		method,
		invocation: { kind: "direct" },
		...hasParams ? { parameters: [{
			name: "request",
			wire: "request",
			source: "json",
			codec: jsonCodec()
		}] } : { parameters: [] },
		result: { mode: "src-json" },
		cancellation: { parameter: "signal" }
	};
}
const TYPERT_REMOTE = {
	package: PACKAGE_NAME,
	descriptors: [
		remoteMethod("ping"),
		remoteMethod("getConnectionStatus"),
		remoteMethod("saveConnectionConfig", true),
		remoteMethod("saveApiKey", true),
		remoteMethod("testConnection"),
		remoteMethod("listSessions"),
		remoteMethod("getSessionMessages", true)
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
	const remote = requireRemote(ctx);
	const api = {
		ping: async () => unwrap(await remote.ping()),
		getConnectionStatus: async () => unwrap(await remote.getConnectionStatus()),
		saveConnectionConfig: async (request) => unwrap(await remote.saveConnectionConfig(request)),
		saveApiKey: async (token) => unwrap(await remote.saveApiKey({ token })),
		testConnection: async () => unwrap(await remote.testConnection()),
		listSessions: async () => unwrap(await remote.listSessions()),
		getSessionMessages: async (sessionId) => unwrap(await remote.getSessionMessages({ sessionId }))
	};
	ctx.slots.inject("main", () => ctx.slots.register({
		name: "main",
		key: PANEL_ID,
		inject: () => ({ api })
	}, HermesWorkspacePanel));
	ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
		name: "sidebar.panellist",
		id: PANEL_ID,
		order: 18,
		label: "Hermes"
	}, HermesIcon));
}
function requireRemote(ctx) {
	const namespace = ctx.remote.hermesWorkspace;
	if (!namespace?.ping || !namespace.getConnectionStatus) throw new Error("Hermes Workspace 服务尚未就绪");
	return namespace;
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
function HermesWorkspacePanel(props) {
	const api = props.api;
	const [status, setStatus] = (0, react.useState)(null);
	const [sessions, setSessions] = (0, react.useState)([]);
	const [selectedId, setSelectedId] = (0, react.useState)(null);
	const [messages, setMessages] = (0, react.useState)([]);
	const [error, setError] = (0, react.useState)(null);
	const [busy, setBusy] = (0, react.useState)(false);
	const [baseUrl, setBaseUrl] = (0, react.useState)("");
	const [displayName, setDisplayName] = (0, react.useState)("Hermes");
	const [profile, setProfile] = (0, react.useState)("default");
	const [token, setToken] = (0, react.useState)("");
	async function refresh(nextApi = api) {
		if (!nextApi) {
			setError("Remote API 未注入");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const nextStatus = await nextApi.getConnectionStatus();
			setStatus(nextStatus);
			if (nextStatus.baseUrl) setBaseUrl(nextStatus.baseUrl);
			setDisplayName(nextStatus.displayName || "Hermes");
			setProfile(nextStatus.profile || "default");
			if (nextStatus.state === "online") {
				const page = await nextApi.listSessions();
				setSessions(page.sessions);
				if (page.sessions[0] && !selectedId) setSelectedId(page.sessions[0].id);
			} else {
				setSessions([]);
				setMessages([]);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}
	(0, react.useEffect)(() => {
		refresh();
	}, [api]);
	(0, react.useEffect)(() => {
		if (!api || !selectedId || status?.state !== "online") return;
		let cancelled = false;
		api.getSessionMessages(selectedId).then((page) => {
			if (!cancelled) setMessages(page.messages);
		}).catch((cause) => {
			if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
		});
		return () => {
			cancelled = true;
		};
	}, [
		api,
		selectedId,
		status?.state
	]);
	async function onSave(event) {
		event.preventDefault();
		if (!api) return;
		setBusy(true);
		setError(null);
		try {
			if (token.trim()) {
				await api.saveApiKey(token.trim());
				setToken("");
			}
			await api.saveConnectionConfig({
				baseUrl,
				displayName,
				profile
			});
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: pageStyle,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
				style: headerStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: kickerStyle,
					children: "Hermes Workspace"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
					style: titleStyle,
					children: status?.displayName || "Hermes"
				})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, { state: status?.state ?? "checking" })]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: bodyStyle,
				children: "接入现有 Hermes Desktop SSH dashboard。Host 会尝试自动发现当前还活着的本机转发端口；SSH 未连接时保持离线，不会沿用已经失效的旧端口。"
			}),
			error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: errorStyle,
				children: error
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				style: cardStyle,
				onSubmit: onSave,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: sectionTitleStyle,
						children: "连接"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: labelStyle,
						children: ["Dashboard URL", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: inputStyle,
							value: baseUrl,
							onChange: (event) => setBaseUrl(event.target.value),
							placeholder: "http://127.0.0.1:59585",
							autoComplete: "off"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: labelStyle,
						children: ["显示名", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: inputStyle,
							value: displayName,
							onChange: (event) => setDisplayName(event.target.value)
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: labelStyle,
						children: ["Profile", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: inputStyle,
							value: profile,
							onChange: (event) => setProfile(event.target.value),
							placeholder: "default"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: labelStyle,
						children: ["Session token（只在 Host 保存，不会回显）", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: inputStyle,
							type: "password",
							value: token,
							onChange: (event) => setToken(event.target.value),
							placeholder: status?.hasToken ? "已配置，留空则不改" : "粘贴 X-Hermes-Session-Token",
							autoComplete: "off"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 8
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "submit",
							style: buttonStyle,
							disabled: busy,
							children: "保存并检测"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: buttonStyle,
							disabled: busy,
							onClick: () => void refresh(),
							children: "重新检测"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: mutedStyle,
						children: status?.errorMessage || status?.version || "尚未检测。"
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: splitStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					style: {
						...cardStyle,
						minWidth: 220
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: sectionTitleStyle,
						children: "会话"
					}), sessions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: mutedStyle,
						children: "在线后会列出 Hermes 历史会话。"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						style: listStyle,
						children: sessions.map((session) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							style: session.id === selectedId ? selectedRowStyle : rowStyle,
							onClick: () => setSelectedId(session.id),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: session.title || session.id }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: mutedStyle,
								children: session.updatedAt || session.id
							})]
						}) }, session.id))
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					style: {
						...cardStyle,
						flex: 1
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: sectionTitleStyle,
						children: "消息"
					}), messages.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: mutedStyle,
						children: "选择一个会话查看历史。发送与流式输出尚未接入。"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "grid",
							gap: 12
						},
						children: messages.map((message) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
							style: messageStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: kickerStyle,
								children: message.role
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
								style: preStyle,
								children: message.text || "（无文本）"
							})]
						}, message.id))
					})]
				})]
			})
		]
	});
}
function StatusBadge({ state }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		style: badgeStyle,
		children: state
	});
}
const pageStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 16,
	height: "100%",
	padding: 24,
	boxSizing: "border-box",
	background: "var(--dsw-alias-bg-primary)",
	color: "var(--dsw-alias-label-primary)",
	overflow: "auto"
};
const headerStyle = {
	display: "flex",
	alignItems: "flex-start",
	justifyContent: "space-between",
	gap: 16
};
const kickerStyle = {
	fontSize: 12,
	color: "var(--dsw-alias-label-secondary)",
	letterSpacing: "0.04em",
	textTransform: "uppercase"
};
const titleStyle = {
	margin: "4px 0 0",
	fontSize: 22,
	fontWeight: 600
};
const bodyStyle = {
	margin: 0,
	maxWidth: 720,
	lineHeight: 1.6,
	color: "var(--dsw-alias-label-secondary)"
};
const cardStyle = {
	border: "1px solid var(--dsw-alias-border-primary)",
	borderRadius: 12,
	padding: 16,
	background: "var(--dsw-alias-bg-secondary)",
	display: "grid",
	gap: 10
};
const sectionTitleStyle = {
	margin: 0,
	fontSize: 14,
	fontWeight: 600
};
const mutedStyle = {
	margin: 0,
	color: "var(--dsw-alias-label-secondary)",
	fontSize: 12
};
const errorStyle = {
	margin: 0,
	color: "var(--dsw-alias-label-danger, #c0392b)"
};
const labelStyle = {
	display: "grid",
	gap: 4,
	fontSize: 12
};
const inputStyle = {
	padding: "8px 10px",
	borderRadius: 8,
	border: "1px solid var(--dsw-alias-border-primary)",
	background: "var(--dsw-alias-bg-primary)",
	color: "inherit"
};
const buttonStyle = {
	padding: "8px 12px",
	borderRadius: 8,
	border: "1px solid var(--dsw-alias-border-primary)",
	background: "var(--dsw-alias-bg-tertiary, var(--dsw-alias-bg-primary))",
	color: "inherit",
	cursor: "pointer"
};
const splitStyle = {
	display: "flex",
	gap: 16,
	alignItems: "stretch",
	minHeight: 280
};
const listStyle = {
	listStyle: "none",
	margin: 0,
	padding: 0,
	display: "grid",
	gap: 6
};
const rowStyle = {
	width: "100%",
	textAlign: "left",
	display: "grid",
	gap: 2,
	padding: 8,
	borderRadius: 8,
	border: "1px solid transparent",
	background: "transparent",
	color: "inherit",
	cursor: "pointer"
};
const selectedRowStyle = {
	...rowStyle,
	border: "1px solid var(--dsw-alias-border-primary)",
	background: "var(--dsw-alias-bg-primary)"
};
const messageStyle = {
	display: "grid",
	gap: 4
};
const preStyle = {
	margin: 0,
	whiteSpace: "pre-wrap",
	fontFamily: "inherit",
	fontSize: 13
};
const badgeStyle = {
	display: "inline-flex",
	alignItems: "center",
	padding: "4px 10px",
	borderRadius: 999,
	fontSize: 12,
	background: "var(--dsw-alias-bg-tertiary, var(--dsw-alias-bg-secondary))",
	color: "var(--dsw-alias-label-secondary)"
};

//#endregion
exports.PANEL_ID = PANEL_ID;
exports.apply = apply;
exports.inject = inject;
return module.exports; } });