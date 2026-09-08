import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import initCore from "../lib/init-core.cjs";

const { buildInitPrompt, initMode, parseInitArgs } = initCore as {
	buildInitPrompt(input: { agentsPath: string; mode: "create" | "update" | "replace" }): string;
	initMode(agentsExists: boolean, force: boolean): "create" | "update" | "replace";
	parseInitArgs(args: string): { force?: boolean; error?: string };
};

export default function initExtension(pi: ExtensionAPI) {
	pi.registerCommand("init", {
		description: "Analyze this project and create/update its AGENTS.md instructions",
		getArgumentCompletions: (prefix) => "--force".startsWith(prefix) ? [{ value: "--force", label: "Regenerate AGENTS.md from project evidence" }] : null,
		handler: async (args, ctx) => {
			const parsed = parseInitArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("pi-sdlc: /init requires a selected model to analyze the project.", "error");
				return;
			}

			const agentsPath = path.join(ctx.cwd, "AGENTS.md");
			const mode = initMode(fs.existsSync(agentsPath), parsed.force === true);
			const prompt = buildInitPrompt({ agentsPath, mode });
			const queued = !ctx.isIdle();
			try {
				pi.sendUserMessage(prompt, queued ? { deliverAs: "followUp" } : undefined);
				ctx.ui.notify(
					queued
						? `pi-sdlc: /init queued; it will ${mode} ${agentsPath} after the current task.`
						: `pi-sdlc: initializing ${agentsPath} from project evidence.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`pi-sdlc: /init could not start: ${String(error)}`, "error");
			}
		},
	});
}
