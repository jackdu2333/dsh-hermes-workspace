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
	descriptors: [remoteMethod("ping"), remoteMethod("getConnectionStatus")]
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
	const api = {
		ping: async () => unwrap(await requireRemote(ctx).ping()),
		getConnectionStatus: async () => unwrap(await requireRemote(ctx).getConnectionStatus())
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
	const [ping, setPing] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)(null);
	(0, react.useEffect)(() => {
		if (!api) {
			setError("Remote API 未注入");
			return;
		}
		let cancelled = false;
		Promise.all([api.getConnectionStatus(), api.ping()]).then(([nextStatus, nextPing]) => {
			if (cancelled) return;
			setStatus(nextStatus);
			setPing(nextPing);
		}).catch((cause) => {
			if (cancelled) return;
			setError(cause instanceof Error ? cause.message : String(cause));
		});
		return () => {
			cancelled = true;
		};
	}, [api]);
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
					children: "独立 Bot 工作区骨架"
				})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, { state: status?.state ?? "checking" })]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: bodyStyle,
				children: "当前阶段只验证 DSH 原生入口、独立主面板和 Host/Client Remote ping。Hermes API、会话与流式对话尚未接入。"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: cardStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
					style: sectionTitleStyle,
					children: "Host 连通"
				}), error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: errorStyle,
					children: error
				}) : ping ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
					style: metaStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "plugin" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: ping.plugin })] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "panel" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: ping.panelId })] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "ping" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: new Date(ping.at).toLocaleString() })] })
					]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: mutedStyle,
					children: "正在调用 Host ping…"
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: cardStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
					style: sectionTitleStyle,
					children: "连接状态"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: mutedStyle,
					children: status?.errorMessage ?? "尚未读取。"
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
	maxWidth: 640,
	lineHeight: 1.6,
	color: "var(--dsw-alias-label-secondary)"
};
const cardStyle = {
	border: "1px solid var(--dsw-alias-border-primary)",
	borderRadius: 12,
	padding: 16,
	background: "var(--dsw-alias-bg-secondary)"
};
const sectionTitleStyle = {
	margin: "0 0 8px",
	fontSize: 14,
	fontWeight: 600
};
const mutedStyle = {
	margin: 0,
	color: "var(--dsw-alias-label-secondary)"
};
const errorStyle = {
	margin: 0,
	color: "var(--dsw-alias-label-danger, #c0392b)"
};
const metaStyle = {
	display: "grid",
	gap: 8,
	margin: 0
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