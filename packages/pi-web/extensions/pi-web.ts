import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import serverModule from "../server/server.cjs";

const { createPiWebServer } = serverModule;
const DEFAULT_HOST = process.env.PI_WEB_HOST || "127.0.0.1";
const parsedPort = Number(process.env.PI_WEB_PORT || 8787);
const DEFAULT_PORT = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 8787;
const AUTO_START = process.env.PI_WEB_AUTO_START !== "0";

export default function piWebExtension(pi: ExtensionAPI) {
	let web: ReturnType<typeof createPiWebServer> | undefined;
	let starting: Promise<void> | undefined;
	let currentCwd = process.cwd();
	let currentSessionId: string | undefined;
	let projectTrusted = false;

	function makeServer() {
		return createPiWebServer({
			host: DEFAULT_HOST,
			port: DEFAULT_PORT,
			cwd: currentCwd,
			agentDir: path.join(os.homedir(), ".pi", "agent"),
			projectTrusted,
			listSessions: () => SessionManager.listAll(),
			listEffectiveSkills: () => pi.getCommands().filter((command) => command.source === "skill"),
			getCurrentSessionId: () => currentSessionId,
			renameSession: (session, name, current) => {
				if (current) pi.setSessionName(name);
				else SessionManager.open(session.path).appendSessionInfo(name);
			},
		});
	}

	async function start(ctx?: ExtensionCommandContext) {
		if (web?.address()) return web.address();
		if (!starting) {
			starting = (async () => {
				web = makeServer();
				try { await web.start(); }
				catch (error) { web = undefined; throw error; }
			})().finally(() => { starting = undefined; });
		}
		await starting;
		const address = web?.address();
		if (ctx && address) ctx.ui.notify(`Pi Web: ${address.url}`, "info");
		return address;
	}

	async function stop(ctx?: ExtensionCommandContext) {
		if (starting) await starting.catch(() => {});
		await web?.stop();
		web = undefined;
		ctx?.ui.setStatus("pi-web", undefined);
		ctx?.ui.notify("Pi Web stopped", "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCwd = ctx.cwd;
		currentSessionId = ctx.sessionManager.getSessionId();
		projectTrusted = ctx.isProjectTrusted();
		if (!AUTO_START) return;
		try {
			const address = await start();
			if (address && ctx.hasUI) ctx.ui.setStatus("pi-web", `web :${address.port}`);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Pi Web failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("pi-web", undefined);
		await stop();
	});

	pi.registerCommand("web", {
		description: "Manage the local Pi Web Control Deck (start|stop|status|open)",
		getArgumentCompletions: (prefix) => ["start", "stop", "status", "open"].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "open";
			if (action === "stop") return stop(ctx);
			if (action === "status") {
				const address = web?.address();
				ctx.ui.notify(address ? `Pi Web running: ${address.url}` : "Pi Web is stopped", address ? "info" : "warning");
				return;
			}
			if (action === "start" || action === "open") {
				const address = await start(ctx);
				if (address) ctx.ui.setStatus("pi-web", `web :${address.port}`);
				return;
			}
			ctx.ui.notify("Usage: /web [start|stop|status|open]", "warning");
		},
	});
}
