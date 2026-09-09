import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import planCore from "../lib/plan-core.cjs";

const core = planCore as any;
const WRITE = new Set(["edit", "write"]);
const STATE_TYPE = "pi-plan-state";
const LEGACY_STATE_TYPE = "pi-sdlc-plan";

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let previous: string[] | undefined;

	const save = () => pi.appendEntry(STATE_TYPE, { enabled, toolsBeforePlanMode: previous });
	const ui = (ctx: ExtensionContext) => ctx.ui.setStatus(
		"pi-plan",
		enabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined,
	);

	pi.registerCommand("plan", {
		description: "Enter read-only collaborative planning mode (/plan off | /plan status)",
		getArgumentCompletions: (prefix) => ["off", "status"]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = core.parsePlanArgs(args);
			if (action.error) return ctx.ui.notify(action.error, "warning");
			if (action.action === "status") return ctx.ui.notify(`pi-plan: plan mode ${enabled ? "enabled" : "disabled"}.`, "info");
			if (action.action === "off") {
				if (enabled) {
					pi.setActiveTools(previous ?? pi.getActiveTools());
					enabled = false;
					previous = undefined;
					save();
					ui(ctx);
				}
				return ctx.ui.notify("pi-plan: plan mode disabled; this is not implementation approval.", "info");
			}
			if (!ctx.isIdle()) return ctx.ui.notify("pi-plan: /plan must be entered while idle.", "warning");
			if (!enabled) {
				previous = pi.getActiveTools();
				pi.setActiveTools(core.PLAN_TOOLS);
				enabled = true;
				save();
				ui(ctx);
			}
			ctx.ui.notify("pi-plan: plan mode enabled (read-only; todo_write is unavailable).", "info");
		},
	});

	pi.on("tool_call", async (event) => {
		if (!enabled) return;
		if (WRITE.has(event.toolName)) return { block: true, reason: "Plan mode is read-only." };
		if (event.toolName === "bash" && !core.isReadOnlyBashCommand(String(event.input.command ?? ""))) {
			return { block: true, reason: "Plan mode only permits one allowlisted read-only bash command." };
		}
		if (!core.PLAN_TOOLS.includes(event.toolName)) return { block: true, reason: `Plan mode blocks ${event.toolName}.` };
	});

	// Always inject the current canonical mode. A prior PLAN MODE message remains
	// in transcript history after /plan off, so omitting a replacement would let
	// stale context mislead the model even though runtime tool permissions reset.
	pi.on("before_agent_start", async () => ({
		message: {
			customType: "pi-plan-context",
			content: enabled ? core.buildPlanPrompt() : core.buildNormalPrompt(),
			display: false,
		},
	}));

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>;
		const entry = entries.filter((item) => item.type === "custom" && (item.customType === STATE_TYPE || item.customType === LEGACY_STATE_TYPE)).pop();
		const state = core.normalizePlanState(entry?.data);
		enabled = state.enabled;
		previous = state.toolsBeforePlanMode;
		if (enabled) pi.setActiveTools(core.PLAN_TOOLS);
		ui(ctx);
	});
}
