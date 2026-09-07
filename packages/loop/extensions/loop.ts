/**
 * pi-loop: persistent goals for pi, modeled after Codex's /goal system
 * (codex-rs/ext/goal). Lets the agent (and the user via /goal) set a
 * durable objective on the thread; the extension keeps the agent working
 * toward it across turns until it completes or a budget/limit is hit.
 *
 * Codex alignment:
 * - goal state machine: Active / Paused / Blocked / UsageLimited /
 *   BudgetLimited / Complete  (codex ThreadGoalStatus)
 * - goal tools: `goal` with create|update|get actions (codex
 *   create_goal / update_goal / get_goal tools)
 * - steering injection: before each continuation the objective + progress
 *   are injected as a steer message (codex continuation_prompt)
 * - automatic loop: after the agent settles, if the goal is Active the
 *   extension calls pi.sendUserMessage(..., { deliverAs: "steer" }) to start
 *   the next turn (codex continue_if_idle)
 * - token budget: tokens_used is accounted from agent_end usage; exceeding
 *   the budget flips the goal to BudgetLimited and stops the loop
 *
 * Storage: ~/.pi/agent/goal.json (cross-session). Guardrails against
 * infinite loops: PI_LOOP_MAX_TURNS (default 20) per goal, plus the budget.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GOAL_FILE = process.env.PI_LOOP_FILE || path.join(os.homedir(), ".pi", "agent", "goal.json");
const MAX_TURNS = Math.max(1, Number(process.env.PI_LOOP_MAX_TURNS) || 20);
const ENABLED = process.env.PI_LOOP !== "0";
const DEBUG = process.env.PI_LOOP_DEBUG === "1";

function debug(...args: unknown[]): void {
	if (DEBUG) console.error("[pi-loop]", ...args);
}

// ---------------------------------------------------------------------------
// Goal model (codex ThreadGoal + ThreadGoalStatus)
// ---------------------------------------------------------------------------

type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";

interface Goal {
	threadId: string;
	objective: string;
	status: GoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	turns: number;
	createdAt: number;
	updatedAt: number;
}

function emptyGoal(): Goal {
	return {
		threadId: "",
		objective: "",
		status: "complete",
		tokenBudget: null,
		tokensUsed: 0,
		turns: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function loadGoal(): Goal {
	try {
		if (fs.existsSync(GOAL_FILE)) {
			const g = JSON.parse(fs.readFileSync(GOAL_FILE, "utf8")) as Partial<Goal>;
			return { ...emptyGoal(), ...g };
		}
	} catch {
		/* corrupt file -> fresh */
	}
	return emptyGoal();
}

function saveGoal(g: Goal): void {
	try {
		fs.mkdirSync(path.dirname(GOAL_FILE), { recursive: true });
		fs.writeFileSync(GOAL_FILE, JSON.stringify(g, null, 2));
	} catch {
		/* best-effort */
	}
}

let goal = loadGoal();

function statusLabel(s: GoalStatus): string {
	return s.replace("_", " ").toUpperCase();
}

// ---------------------------------------------------------------------------
// Token accounting (agent_end usage)
// ---------------------------------------------------------------------------

function extractTokenUsage(event: { messages: Array<{ usage?: { totalTokens?: number } }> }): number {
	let total = 0;
	for (const m of event.messages) {
		total += m.usage?.totalTokens ?? 0;
	}
	return total;
}

/** Apply budget/limits after accounting; returns the new status. */
function enforceLimits(g: Goal): GoalStatus {
	if (g.status !== "active") return g.status;
	if (g.tokenBudget !== null && g.tokensUsed >= g.tokenBudget) {
		g.status = "budget_limited";
	} else if (g.turns >= MAX_TURNS) {
		g.status = "usage_limited"; // codex UsageLimited (max turns as a usage guardrail)
	}
	return g.status;
}

// ---------------------------------------------------------------------------
// Steering (codex continuation_prompt)
// ---------------------------------------------------------------------------

function continuationMessage(g: Goal): string {
	const budget = g.tokenBudget !== null ? `${g.turns} turns / ${g.tokensUsed}/${g.tokenBudget} tokens` : `${g.turns} turns / ${g.tokensUsed} tokens`;
	return [
		`## Goal continuation (pi-loop)`,
		``,
		`Keep working toward the active goal below. You are the agent in a loop; continue making progress autonomously.`,
		`When the goal is achieved, call the goal tool with action "update", status "complete", and a short summary.`,
		`If you are blocked and need the user, set status "blocked" instead of looping.`,
		``,
		`<goal objective="${g.objective}">`,
		`<progress>${budget}</progress>`,
		`</goal>`,
		``,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	if (!ENABLED) return;

	// Steering injection before each turn when a goal is active
	// (codex on_turn_start / inject_active_turn_steering)
	pi.on("before_agent_start", async () => {
		try {
			if (goal.status !== "active") return;
			return {
				message: {
					customType: "pi-loop-steering",
					content: continuationMessage(goal),
					display: false,
				},
			};
		} catch {
			return undefined;
		}
	});

	// Token accounting + automatic continuation (codex on_token_usage +
	// continue_if_idle)
	pi.on("agent_end", async (event, ctx) => {
		try {
			if (goal.status !== "active") return;
			goal.tokensUsed += extractTokenUsage(event as never);
			enforceLimits(goal);
			saveGoal(goal);
			if (goal.status !== "active") {
				ctx.ui.notify(`pi-loop: goal ${statusLabel(goal.status)} (${goal.turns} turns, ${goal.tokensUsed} tokens)`, "info");
			}
		} catch {
			/* never break */
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			if (goal.status !== "active") return;
			// print/CI mode exits after one run, so a queued continuation never
			// executes — only auto-loop in resident modes (TUI/RPC).
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
			goal.turns += 1; // one autonomous loop turn toward the goal
			goal.updatedAt = Date.now();
			enforceLimits(goal);
			saveGoal(goal);
			if (goal.status !== "active") {
				// hit budget/max turns — stop the loop (codex BudgetLimited/UsageLimited)
				return;
			}
			// Loop: kick off the next turn toward the goal (codex continue_if_idle)
			debug("continuing goal", goal.objective.slice(0, 60));
			pi.sendUserMessage(continuationMessage(goal), { deliverAs: "steer" });
		} catch {
			/* never break */
		}
	});

	// ------------------------------------------------------------------
	// goal tool (codex create_goal / update_goal / get_goal)
	// ------------------------------------------------------------------
	pi.registerTool({
		name: "goal",
		label: "Goal",
		description:
			"Manage a persistent goal for this conversation (Codex-style). " +
			'actions: "create" (set a new objective), "update" (change objective/status/progress), "get" (read current goal). ' +
			"status: active (keep working, loop continues), complete (done), paused, blocked (need user), " +
			"budget_limited, usage_limited. When the goal is achieved, update it to complete — that stops the loop.",
		promptSnippet:
			"For long-running or multi-step tasks, create a goal with the goal tool; update it as you progress and set it complete when done.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("get")]),
			objective: Type.Optional(Type.String({ description: "The goal objective (<= 2000 chars)." })),
			status: Type.Optional(
				Type.Union([
					Type.Literal("active"),
					Type.Literal("complete"),
					Type.Literal("paused"),
					Type.Literal("blocked"),
				]),
			),
			token_budget: Type.Optional(Type.Integer({ description: "Optional token budget for the goal." })),
			summary: Type.Optional(Type.String({ description: "Optional completion/update summary." })),
		}),
		async execute(_id, params) {
			const now = Date.now();
			if (params.action === "create") {
				if (!params.objective?.trim()) return textResult("goal: objective is required for create", true);
				goal = {
					threadId: goal.threadId || "session",
					objective: params.objective.trim().slice(0, 2000),
					status: params.status ?? "active",
					tokenBudget: params.token_budget ?? null,
					tokensUsed: 0,
					turns: 0,
					createdAt: now,
					updatedAt: now,
				};
				saveGoal(goal);
				return textResult(`goal created: ${goal.objective} (${statusLabel(goal.status)})`);
			}
			if (params.action === "update") {
				if (params.objective) goal.objective = params.objective.trim().slice(0, 2000);
				if (params.status) goal.status = params.status;
				if (params.token_budget !== undefined) goal.tokenBudget = params.token_budget;
				goal.updatedAt = now;
				if (goal.status === "complete" && params.summary) {
					// fold summary into objective history for the final recall
					goal.objective = `${goal.objective} — [complete] ${params.summary}`.slice(0, 2000);
				}
				saveGoal(goal);
				return textResult(`goal updated: ${statusLabel(goal.status)} — ${goal.objective}`);
			}
			// get
			if (goal.status === "complete" && !goal.objective) return textResult("no active goal");
			return textResult(
				`goal: ${statusLabel(goal.status)}\nobjective: ${goal.objective}\nprogress: ${goal.turns} turns, ${goal.tokensUsed} tokens${goal.tokenBudget !== null ? ` / ${goal.tokenBudget} budget` : ""}\ncreated: ${new Date(goal.createdAt).toISOString()}`,
			);
		},
	});

	// ------------------------------------------------------------------
	// /goal command
	// ------------------------------------------------------------------
	pi.registerCommand("goal", {
		description:
			"pi-loop: /goal (status) | /goal set <objective> [budget] | /goal pause | /goal resume | /goal complete | /goal clear",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const sub = (parts[0] || "").toLowerCase();
			if (sub === "set") {
				const objective = (args || "").slice(parts[0].length).trim();
				if (!objective) {
					ctx.ui.notify("pi-loop: usage — /goal set <objective> [token_budget]", "warning");
					return;
				}
				const m = objective.match(/^(.*?)\s+(\d+)\s*$/);
				const text = m ? m[1] : objective;
				const budget = m ? Number(m[2]) : null;
				goal = {
					threadId: "session",
					objective: text.slice(0, 2000),
					status: "active",
					tokenBudget: budget,
					tokensUsed: 0,
					turns: 0,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};
				saveGoal(goal);
				ctx.ui.notify(`pi-loop: goal set — ${goal.objective} (active, ${budget ?? "no"} token budget)`, "info");
				return;
			}
			if (sub === "pause") {
				if (goal.status !== "complete" && goal.objective) {
					goal.status = "paused";
					goal.updatedAt = Date.now();
					saveGoal(goal);
					ctx.ui.notify("pi-loop: goal paused", "info");
				} else ctx.ui.notify("pi-loop: no active goal to pause", "warning");
				return;
			}
			if (sub === "resume") {
				if (goal.objective) {
					goal.status = "active";
					goal.updatedAt = Date.now();
					saveGoal(goal);
					ctx.ui.notify(`pi-loop: goal resumed — ${goal.objective}`, "info");
				} else ctx.ui.notify("pi-loop: no goal to resume", "warning");
				return;
			}
			if (sub === "complete") {
				if (goal.objective) {
					goal.status = "complete";
					goal.updatedAt = Date.now();
					saveGoal(goal);
					ctx.ui.notify("pi-loop: goal marked complete", "info");
				} else ctx.ui.notify("pi-loop: no goal", "warning");
				return;
			}
			if (sub === "clear") {
				goal = emptyGoal();
				saveGoal(goal);
				ctx.ui.notify("pi-loop: goal cleared", "info");
				return;
			}
			// default: status
			if (!goal.objective) {
				ctx.ui.notify("pi-loop: no goal. Usage: /goal set <objective> [token_budget]", "info");
				return;
			}
			ctx.ui.notify(
				[
					`pi-loop goal (${statusLabel(goal.status)})`,
					`objective: ${goal.objective}`,
					`progress: ${goal.turns} turns, ${goal.tokensUsed} tokens${goal.tokenBudget !== null ? ` / ${goal.tokenBudget} budget` : ""}`,
					`created: ${new Date(goal.createdAt).toISOString()}`,
					`max turns: ${MAX_TURNS}`,
				].join("\n"),
				"info",
			);
		},
	});
}

function textResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}
