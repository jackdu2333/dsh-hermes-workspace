import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

//#region src/shared/constants.ts
/** 插件包名，与 package.json name 一致。 */
const PACKAGE_NAME = "@jackdu/dsh-hermes-workspace";
/** Loader 行 id / 左侧面板 id / main keyed slot key。 */
const PANEL_ID = "hermes-workspace";
/** Typert Remote namespace，Client 通过 ctx.remote.hermesWorkspace 访问。 */
const REMOTE_NAMESPACE = "hermesWorkspace";

//#endregion
//#region src/host/HermesBridgeService.ts
/**
* P0-00 骨架：只暴露 ping / 连接状态占位。
* 真实 Hermes HTTP / SSE / Credentials 在 P0-02 接入，这里不假装已连通。
*
* 不使用 @Remote() 语法：当前 tsdown 不会转译装饰器。
* 按 qiaomu-rss 的方式在类定义后用 Remote(name) 注册。
*/
var HermesBridgeService = class extends TypertRemoteService {
	static inject = [];
	constructor(ctx) {
		super(ctx, REMOTE_NAMESPACE);
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
		return {
			state: "unconfigured",
			displayName: "Hermes",
			profile: "",
			errorCode: "unconfigured",
			errorMessage: "Hermes API 尚未配置。当前仅完成插件骨架。"
		};
	}
};
const prototype = HermesBridgeService.prototype;
for (const name of ["ping", "getConnectionStatus"]) Remote(name)(prototype[name], {
	name,
	private: false,
	static: false,
	addInitializer(fn) {
		fn.call(Object.create(prototype));
	}
});

//#endregion
export { HermesBridgeService, HermesBridgeService as default };