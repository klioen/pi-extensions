import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import larkCore from "../lib/lark-core.cjs";

const core = larkCore as any;
const STATE_TYPE = "pi-lark-state";

export default function (pi: ExtensionAPI) {
	let enabled = false;

	const save = () => pi.appendEntry(STATE_TYPE, { enabled });
	const updateStatus = (ctx: ExtensionContext) => ctx.ui.setStatus(
		"pi-lark",
		enabled ? ctx.ui.theme.fg("accent", "Lark: ON") : undefined,
	);
	const enable = (ctx: ExtensionContext) => {
		if (enabled) return;
		enabled = true;
		save();
		updateStatus(ctx);
	};

	pi.registerCommand("lark", {
		description: "Enable Lark skills (/lark off | /lark status | /lark <request>)",
		getArgumentCompletions: (prefix) => ["off", "status"]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = core.parseLarkArgs(args);
			if (action.action === "status") {
				ctx.ui.notify(`pi-lark: Lark mode ${enabled ? "enabled" : "disabled"}.`, "info");
				return;
			}
			if (action.action === "off") {
				if (enabled) {
					enabled = false;
					save();
					updateStatus(ctx);
				}
				ctx.ui.notify("pi-lark: Lark mode disabled.", "info");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("pi-lark: /lark must be entered while the agent is idle.", "warning");
				return;
			}

			enable(ctx);
			if (action.action === "request") {
				pi.sendUserMessage(action.request);
				return;
			}
			ctx.ui.notify("pi-lark: Lark mode enabled.", "info");
		},
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: enabled ? event.systemPrompt : core.filterLarkSkillsFromPrompt(event.systemPrompt),
		message: {
			customType: "pi-lark-context",
			content: core.buildLarkPrompt(enabled),
			display: false,
		},
	}));

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>;
		const entry = entries
			.filter((item) => item.type === "custom" && item.customType === STATE_TYPE)
			.pop();
		enabled = core.normalizeLarkState(entry?.data).enabled;
		updateStatus(ctx);
	});
}
