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
	/** consecutive goal turns in which the agent reported blocked (codex blocked audit) */
	blockedConsecutive: number;
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
		blockedConsecutive: 0,
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
		`When the goal is achieved, call the update_goal tool with status "complete".`,
		`If you are blocked and need the user, call update_goal with status "blocked" instead of looping.`,
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
	// ------------------------------------------------------------------
	// goal tools (codex create_goal / update_goal / get_goal)
	// ------------------------------------------------------------------
	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. " +
			"Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
		promptSnippet:
			"Only create a goal when the user or system explicitly asks for one (e.g. a long-running objective); otherwise just do the task.",
		parameters: Type.Object({
			objective: Type.String({ description: "Required. The concrete objective to start pursuing. Starts a new active goal when none exists or replaces a completed one." }),
			token_budget: Type.Optional(Type.Integer({ description: "Positive token budget for the new goal. Omit unless explicitly requested." })),
		}),
		async execute(_id, params) {
			if (!params.objective?.trim()) return textResult("create_goal: objective is required", true);
			if (goal.status === "active") {
				return textResult(`create_goal: an unfinished goal already exists — ${goal.objective}. Use get_goal / update_goal instead.`, true);
			}
			goal = {
				threadId: "session",
				objective: params.objective.trim().slice(0, 2000),
				status: "active",
				tokenBudget: params.token_budget ?? null,
				tokensUsed: 0,
				turns: 0,
				blockedConsecutive: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			saveGoal(goal);
			return textResult(`goal created: ${goal.objective} (active${goal.tokenBudget !== null ? `, budget ${goal.tokenBudget}` : ""})`);
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Update the existing goal. Use this tool only to mark the goal achieved (complete) or genuinely blocked. " +
			"Set status to complete only when the objective has actually been achieved and no required work remains. " +
			"Set status to blocked only when the same blocking condition has repeated for at least three consecutive goal turns and you cannot make progress without user input or an external-state change. " +
			"Once the blocked threshold is satisfied, do not keep reporting while leaving the goal active. " +
			"Do not use blocked merely because the work is hard, slow, uncertain, or would benefit from clarification. " +
			"You cannot pause, resume, budget-limit, or usage-limit a goal; those are user/system controlled. " +
			"When marking a budgeted goal complete, report the final token usage from the tool result to the user.",
		promptSnippet:
			"Update a goal to complete only when its objective is truly achieved, or to blocked after 3 consecutive turns stuck on the same obstacle.",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
		}),
		async execute(_id, params) {
			if (!goal.objective) return textResult("update_goal: no goal exists — use create_goal first", true);
			if (goal.status !== "active") {
				return textResult(`update_goal: goal is ${statusLabel(goal.status)}; only active goals can be updated`, true);
			}
			if (params.status === "complete") {
				goal.status = "complete";
				goal.blockedConsecutive = 0;
				goal.updatedAt = Date.now();
				saveGoal(goal);
				return textResult(`goal complete: ${goal.objective} (${goal.turns} turns, ${goal.tokensUsed} tokens used)`);
			}
			// blocked: require 3 consecutive turns stuck on the same condition
			goal.blockedConsecutive += 1;
			goal.updatedAt = Date.now();
			saveGoal(goal);
			if (goal.blockedConsecutive < 3) {
				return textResult(
					`blocked reported (${goal.blockedConsecutive}/3 consecutive). Keep trying; only set blocked after 3 consecutive goal turns on the same obstacle.`,
				);
			}
			goal.status = "blocked";
			saveGoal(goal);
			return textResult(`goal blocked: ${goal.objective} (after ${goal.blockedConsecutive} consecutive turns)`);
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description:
			"Get the current goal for this thread, including status, budgets, token usage, and remaining token budget.",
		promptSnippet: "Check the current goal with get_goal before deciding whether to keep working.",
		parameters: Type.Object({}),
		async execute() {
			if (!goal.objective) return textResult("no goal");
			const remaining = goal.tokenBudget !== null ? Math.max(0, goal.tokenBudget - goal.tokensUsed) : null;
			return textResult(
				`goal: ${statusLabel(goal.status)}\nobjective: ${goal.objective}\nprogress: ${goal.turns} turns, ${goal.tokensUsed} tokens${goal.tokenBudget !== null ? ` / ${goal.tokenBudget} budget (${remaining} remaining)` : ""}\ncreated: ${new Date(goal.createdAt).toISOString()}`,
			);
		},
	});
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
					blockedConsecutive: 0,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};
				saveGoal(goal);
				ctx.ui.notify(`pi-loop: goal set — ${goal.objective} (active, ${budget ?? "no"} token budget)`, "info");
				// kick off the first turn toward the goal immediately (codex
				// continue_if_idle after setting a goal)
				pi.sendUserMessage(continuationMessage(goal), { deliverAs: "steer" });
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
					pi.sendUserMessage(continuationMessage(goal), { deliverAs: "steer" });
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
