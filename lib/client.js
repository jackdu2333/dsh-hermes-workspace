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
function remoteMethod(method) {
	return {
		id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}`,
		service: REMOTE_NAMESPACE,
		namespace: REMOTE_NAMESPACE,
		method,
		invocation: { kind: "direct" },
		parameters: [],
		result: { mode: "src-json" },
		cancellation: { parameter: "signal" }
	};
}
const TYPERT_REMOTE = {
	package: PACKAGE_NAME,
	descriptors: [remoteMethod("getNativeChatTarget"), remoteMethod("openNativeChat")]
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
		getNativeChatTarget: async () => {
			if (!remote?.getNativeChatTarget) throw new Error("Hermes Workspace 服务尚未就绪");
			return unwrap(await remote.getNativeChatTarget());
		},
		openNativeChat: async () => {
			if (!remote?.openNativeChat) throw new Error("Hermes Workspace 服务尚未就绪");
			return unwrap(await remote.openNativeChat());
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
function HermesChatPanel(props) {
	const api = props.api;
	const opened = (0, react.useRef)(false);
	const [target, setTarget] = (0, react.useState)(null);
	const [status, setStatus] = (0, react.useState)("正在打开 Hermes 原生对话区…");
	const [error, setError] = (0, react.useState)(null);
	async function openChat() {
		if (!api) {
			setError("Remote API 未注入");
			return;
		}
		setError(null);
		try {
			const next = await api.getNativeChatTarget();
			setTarget(next);
			if (!next.available) {
				setError(next.errorMessage || "未找到 hermes dashboard");
				setStatus("没有可用的原生 /chat");
				return;
			}
			const result = await api.openNativeChat();
			if (result.ok) setStatus(`已打开 ${next.url}`);
			else setError(result.errorMessage || "无法打开浏览器");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}
	(0, react.useEffect)(() => {
		if (opened.current) return;
		opened.current = true;
		openChat();
	}, [api]);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: pageStyle,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: kickerStyle,
				children: "Hermes"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
				style: titleStyle,
				children: "原生 Bot 对话区"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: bodyStyle,
				children: "官方网页 Chat 必须在它自己的 origin 打开（`hermes dashboard` 的 `/chat`）。嵌进 DSH 会被跨源拦住，PTY/WebSocket 会一直停在 Loading chat。"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				style: mutedStyle,
				children: [status, target?.version ? ` · ${target.version}` : ""]
			}),
			error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: errorStyle,
				children: error
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				style: buttonStyle,
				onClick: () => void openChat(),
				children: "打开 Hermes Chat"
			})
		]
	});
}
const pageStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 12,
	height: "100%",
	padding: 32,
	boxSizing: "border-box",
	background: "var(--dsw-alias-bg-primary)",
	color: "var(--dsw-alias-label-primary)"
};
const kickerStyle = {
	fontSize: 12,
	color: "var(--dsw-alias-label-secondary)",
	letterSpacing: "0.04em",
	textTransform: "uppercase"
};
const titleStyle = {
	margin: 0,
	fontSize: 22,
	fontWeight: 600
};
const bodyStyle = {
	margin: 0,
	maxWidth: 640,
	lineHeight: 1.6,
	color: "var(--dsw-alias-label-secondary)"
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
const buttonStyle = {
	alignSelf: "flex-start",
	padding: "8px 12px",
	borderRadius: 8,
	border: "1px solid var(--dsw-alias-border-primary)",
	background: "var(--dsw-alias-bg-secondary)",
	color: "inherit",
	cursor: "pointer"
};

//#endregion
exports.PANEL_ID = PANEL_ID;
exports.apply = apply;
exports.inject = inject;
return module.exports; } });