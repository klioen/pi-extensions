/**
 * pi-loop: persistent per-session goals for pi, modeled after Codex's /goal
 * system (codex-rs/ext/goal). Storage mirrors codex: a `goals` table keyed
 * by session id (codex keys by thread id — in pi the session is the unit of
 * conversation, and each session carries its own goal), plus a
 * `goal_continuation_deferrals` table for the deferral marker.
 *
 * Codex alignment:
 * - goal state machine: active / paused / blocked / usage_limited /
 *   budget_limited / complete  (codex ThreadGoalStatus)
 * - tools: create_goal / update_goal / get_goal (codex tool names)
 * - steering: continuation message injected each turn (display:false,
 *   LLM-context only — codex continuation steering item)
 * - automatic loop: after the agent settles, if the goal is active the
 *   extension silently starts the next turn (codex continue_if_idle)
 * - token budget: tokens_used accounted from agent_end per-request deltas;
 *   exceeding the budget flips the goal to budget_limited
 * - time audit: time_used_seconds accumulated per turn (codex field)
 * - deferral: writing a goal defers auto-continuation once; the next
 *   user-initiated turn clears it (codex thread_goal_continuation_deferrals)
 *
 * Guardrails: PI_LOOP_MAX_TURNS (default 20) → usage_limited;
 * unbudgeted goals default to PI_LOOP_MAX_GOAL_TOKEN_BUDGET (100000).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DB_PATH = process.env.PI_LOOP_DB || path.join(os.homedir(), ".pi", "agent", "goal.db");
const MAX_TURNS = Math.max(1, Number(process.env.PI_LOOP_MAX_TURNS) || 20);
/**
 * Default token budget when the user/agent does not specify one. Mirrors
 * Codex's max_goal_token_budget: a goal without an explicit budget still
 * cannot run forever.
 */
const DEFAULT_BUDGET = Math.max(1, Number(process.env.PI_LOOP_MAX_GOAL_TOKEN_BUDGET) || 100000);
const ENABLED = process.env.PI_LOOP !== "0";
const DEBUG = process.env.PI_LOOP_DEBUG === "1";

function debug(...args: unknown[]): void {
	if (DEBUG) console.error("[pi-loop]", ...args);
}

// ---------------------------------------------------------------------------
// Schema (mirrors codex state/goals_migrations + thread_goal_continuation_deferrals)
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
    session_id TEXT PRIMARY KEY NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'active','paused','blocked','usage_limited','budget_limited','complete'
    )),
    token_budget INTEGER,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0,
    blocked_consecutive INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS goal_continuation_deferrals (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES goals(session_id) ON DELETE CASCADE
);
`;

let db: DatabaseSync | null = null;
function getDb(): DatabaseSync {
	if (!db) {
		db = new DatabaseSync(DB_PATH);
		db.exec(SCHEMA);
	}
	return db;
}

// ---------------------------------------------------------------------------
// Goal model (codex ThreadGoal + ThreadGoalStatus)
// ---------------------------------------------------------------------------

type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";

interface Goal {
	sessionId: string;
	objective: string;
	status: GoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	turns: number;
	blockedConsecutive: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

function rowToGoal(row: Record<string, unknown>): Goal {
	return {
		sessionId: row.session_id as string,
		objective: row.objective as string,
		status: row.status as GoalStatus,
		tokenBudget: row.token_budget === null ? null : (row.token_budget as number),
		tokensUsed: row.tokens_used as number,
		turns: row.turns as number,
		blockedConsecutive: row.blocked_consecutive as number,
		timeUsedSeconds: row.time_used_seconds as number,
		createdAt: row.created_at_ms as number,
		updatedAt: row.updated_at_ms as number,
	};
}

function loadGoal(sessionId: string): Goal | null {
	const row = getDb().prepare("SELECT * FROM goals WHERE session_id = ?").get(sessionId);
	return row ? rowToGoal(row as Record<string, unknown>) : null;
}

function saveGoal(g: Goal): void {
	getDb()
		.prepare(
			`INSERT INTO goals (
				session_id, objective, status, token_budget, tokens_used, turns,
				blocked_consecutive, time_used_seconds, created_at_ms, updated_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				objective = excluded.objective,
				status = excluded.status,
				token_budget = excluded.token_budget,
				tokens_used = excluded.tokens_used,
				turns = excluded.turns,
				blocked_consecutive = excluded.blocked_consecutive,
				time_used_seconds = excluded.time_used_seconds,
				updated_at_ms = excluded.updated_at_ms`,
		)
		.run(
			g.sessionId,
			g.objective,
			g.status,
			g.tokenBudget,
			g.tokensUsed,
			g.turns,
			g.blockedConsecutive,
			g.timeUsedSeconds,
			g.createdAt,
			g.updatedAt,
		);
}

function deleteGoal(sessionId: string): void {
	// deferrals cascade on session_id
	getDb().prepare("DELETE FROM goals WHERE session_id = ?").run(sessionId);
}

// --- deferral (codex thread_goal_continuation_deferrals) ---

function hasDeferral(sessionId: string): boolean {
	return getDb()
		.prepare("SELECT 1 FROM goal_continuation_deferrals WHERE session_id = ?")
		.get(sessionId) !== undefined;
}

function setDeferral(sessionId: string): void {
	getDb()
		.prepare("INSERT OR IGNORE INTO goal_continuation_deferrals (session_id) VALUES (?)")
		.run(sessionId);
}

function clearDeferral(sessionId: string): void {
	getDb().prepare("DELETE FROM goal_continuation_deferrals WHERE session_id = ?").run(sessionId);
}

// ---------------------------------------------------------------------------
// Session id + token accounting
// ---------------------------------------------------------------------------

function getSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

/**
 * Sum the per-request token cost of this run's messages.
 * IMPORTANT: usage.totalTokens is cumulative across turns; input/output are
 * per-request deltas. Summing totalTokens double-counts history.
 */
function extractTokenUsage(event: { messages: Array<{ usage?: { input?: number; output?: number } }> }): number {
	let total = 0;
	for (const m of event.messages) {
		const u = m.usage;
		if (u) total += (u.input ?? 0) + (u.output ?? 0);
	}
	return total;
}

/** Apply budget/limits after accounting; returns the new status. */
function enforceLimits(g: Goal): GoalStatus {
	if (g.status !== "active") return g.status;
	if (g.tokenBudget !== null && g.tokensUsed >= g.tokenBudget) {
		g.status = "budget_limited";
	} else if (g.turns >= MAX_TURNS) {
		g.status = "usage_limited"; // usage guardrail (codex UsageLimited)
	}
	return g.status;
}

function statusLabel(s: GoalStatus): string {
	return s.replace("_", " ").toUpperCase();
}

// ---------------------------------------------------------------------------
// Steering (codex continuation_prompt)
// ---------------------------------------------------------------------------

function continuationMessage(g: Goal): string {
	const budget = g.tokenBudget !== null ? `${g.turns} turns / ${g.tokensUsed}/${g.tokenBudget} tokens` : `${g.turns} turns / ${g.tokensUsed} tokens`;
	const time = g.timeUsedSeconds > 0 ? `, ${formatSeconds(g.timeUsedSeconds)} elapsed` : "";
	return [
		`## Goal continuation (pi-loop)`,
		``,
		`Keep working toward the active goal below. You are the agent in a loop; continue making progress autonomously.`,
		`When the goal is achieved, call the update_goal tool with status "complete".`,
		`If you are blocked and need the user, call update_goal with status "blocked" instead of looping.`,
		``,
		`<goal objective="${g.objective}">`,
		`<progress>${budget}${time}</progress>`,
		`</goal>`,
		``,
	].join("\n");
}

function formatSeconds(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

/**
 * Silently kick off a new turn toward the active goal of `sessionId`.
 * display:false so the steering only enters the LLM context and never shows
 * in the transcript (codex continuation steering item). Turns started this
 * way bypass before_agent_start, so no duplicate injection.
 */
function kickoffTurn(pi: ExtensionAPI, sessionId: string): void {
	const g = loadGoal(sessionId);
	if (!g) return;
	pi.sendMessage(
		{
			customType: "pi-loop-continue",
			content: continuationMessage(g),
			display: false,
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	if (!ENABLED) return;

	// Per-turn elapsed-time tracking (codex time_used_seconds)
	const turnStarts = new Map<string, number>();
	pi.on("agent_start", async (_event, ctx) => {
		try {
			turnStarts.set(getSessionId(ctx), Date.now());
		} catch {
			/* never break */
		}
	});

	// Steering injection before each user-initiated turn when a goal is
	// active; also clears the deferral (codex on_turn_start)
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const sid = getSessionId(ctx);
			clearDeferral(sid); // codex on_turn_start clears the deferral
			const g = loadGoal(sid);
			if (!g || g.status !== "active") return;
			return {
				message: {
					customType: "pi-loop-steering",
					content: continuationMessage(g),
					display: false,
				},
			};
		} catch {
			return undefined;
		}
	});

	// Token + time accounting (codex on_token_usage)
	pi.on("agent_end", async (event, ctx) => {
		try {
			const sid = getSessionId(ctx);
			const g = loadGoal(sid);
			if (!g || g.status !== "active") return;
			g.tokensUsed += extractTokenUsage(event as never);
			const start = turnStarts.get(sid);
			if (start !== undefined) {
				g.timeUsedSeconds += Math.max(0, Math.round((Date.now() - start) / 1000));
				turnStarts.delete(sid);
			}
			enforceLimits(g);
			g.updatedAt = Date.now();
			saveGoal(g);
			if (g.status !== "active") {
				ctx.ui.notify(`pi-loop: goal ${statusLabel(g.status)} (${g.turns} turns, ${g.tokensUsed} tokens)`, "info");
			}
		} catch {
			/* never break */
		}
	});

	// Automatic continuation (codex continue_if_idle)
	pi.on("agent_settled", async (_event, ctx) => {
		try {
			const sid = getSessionId(ctx);
			const g = loadGoal(sid);
			if (!g || g.status !== "active") return;
			// print/CI mode exits after one run — only auto-loop in resident modes
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
			// codex continue_if_idle: a goal that was just written defers
			// continuation once — stop and let the user see the result.
			if (hasDeferral(sid)) {
				clearDeferral(sid);
				debug("deferring continuation until next user message");
				return;
			}
			g.turns += 1;
			enforceLimits(g);
			g.updatedAt = Date.now();
			saveGoal(g);
			if (g.status !== "active") return;
			debug("continuing goal", g.objective.slice(0, 60));
			kickoffTurn(pi, sid);
		} catch {
			/* never break */
		}
	});

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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const sid = getSessionId(ctx);
			const existing = loadGoal(sid);
			if (existing && existing.status === "active") {
				return textResult(`create_goal: an unfinished goal already exists — ${existing.objective}. Use get_goal / update_goal instead.`, true);
			}
			const now = Date.now();
			const g: Goal = {
				sessionId: sid,
				objective: params.objective.trim().slice(0, 2000),
				status: "active",
				tokenBudget: params.token_budget ?? DEFAULT_BUDGET,
				tokensUsed: 0,
				turns: 0,
				blockedConsecutive: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			};
			saveGoal(g);
			setDeferral(sid); // pause auto-continuation until the user's next message
			return textResult(`goal created: ${g.objective} (active${g.tokenBudget !== null ? `, budget ${g.tokenBudget}` : ""})`);
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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const sid = getSessionId(ctx);
			const g = loadGoal(sid);
			if (!g) return textResult("update_goal: no goal exists — use create_goal first", true);
			if (g.status !== "active") {
				return textResult(`update_goal: goal is ${statusLabel(g.status)}; only active goals can be updated`, true);
			}
			if (params.status === "complete") {
				g.status = "complete";
				g.blockedConsecutive = 0;
				g.updatedAt = Date.now();
				saveGoal(g);
				setDeferral(sid);
				return textResult(`goal complete: ${g.objective} (${g.turns} turns, ${g.tokensUsed} tokens used, ${formatSeconds(g.timeUsedSeconds)})`);
			}
			// blocked: require 3 consecutive turns stuck on the same condition
			g.blockedConsecutive += 1;
			g.updatedAt = Date.now();
			saveGoal(g);
			if (g.blockedConsecutive < 3) {
				return textResult(
					`blocked reported (${g.blockedConsecutive}/3 consecutive). Keep trying; only set blocked after 3 consecutive goal turns on the same obstacle.`,
				);
			}
			g.status = "blocked";
			saveGoal(g);
			setDeferral(sid);
			return textResult(`goal blocked: ${g.objective} (after ${g.blockedConsecutive} consecutive turns)`);
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description:
			"Get the current goal for this session, including status, budgets, token and time usage, and remaining token budget.",
		promptSnippet: "Check the current goal with get_goal before deciding whether to keep working.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const g = loadGoal(getSessionId(ctx));
			if (!g) return textResult("no goal");
			const remaining = g.tokenBudget !== null ? Math.max(0, g.tokenBudget - g.tokensUsed) : null;
			return textResult(
				`goal: ${statusLabel(g.status)}\nobjective: ${g.objective}\nprogress: ${g.turns} turns, ${g.tokensUsed} tokens${g.tokenBudget !== null ? ` / ${g.tokenBudget} budget (${remaining} remaining)` : ""}${g.timeUsedSeconds > 0 ? `, ${formatSeconds(g.timeUsedSeconds)} elapsed` : ""}\ncreated: ${new Date(g.createdAt).toISOString()}`,
			);
		},
	});

	// ------------------------------------------------------------------
	// /goal command (codex usage: /goal [<objective>|clear|edit|pause|resume])
	// ------------------------------------------------------------------
	pi.registerCommand("goal", {
		description:
			"pi-loop: /goal [<objective>|clear|edit|pause|resume] (Codex usage)",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const sub = (parts[0] || "").toLowerCase();
			const sid = getSessionId(ctx);
			// Codex usage: /goal <objective> sets the goal directly. A trailing
			// number on the objective is an explicit token budget (pi extension).
			const setGoal = (objective: string, budget: number | null) => {
				const now = Date.now();
				const g: Goal = {
					sessionId: sid,
					objective: objective.slice(0, 2000),
					status: "active",
					tokenBudget: budget,
					tokensUsed: 0,
					turns: 0,
					blockedConsecutive: 0,
					timeUsedSeconds: 0,
					createdAt: now,
					updatedAt: now,
				};
				saveGoal(g);
				setDeferral(sid); // deferred: run one turn, then stop for the user
				ctx.ui.notify(`pi-loop: goal set — ${g.objective} (active, ${budget ?? "no"} token budget)`, "info");
				kickoffTurn(pi, sid); // codex continue_if_idle after setting a goal
			};
			if (sub === "set" || sub === "edit") {
				const objective = (args || "").slice(parts[0].length).trim();
				if (!objective) {
					ctx.ui.notify("pi-loop: usage — /goal <objective> [token_budget]", "warning");
					return;
				}
				const m = objective.match(/^(.*?)\s+(\d+)\s*$/);
				const text = m ? m[1] : objective;
				const budget = m ? Number(m[2]) : DEFAULT_BUDGET;
				setGoal(text, budget);
				return;
			}
			if (sub === "pause") {
				const g = loadGoal(sid);
				if (g && g.status !== "complete" && g.objective) {
					g.status = "paused";
					g.updatedAt = Date.now();
					saveGoal(g);
					setDeferral(sid);
					ctx.ui.notify("pi-loop: goal paused", "info");
				} else ctx.ui.notify("pi-loop: no active goal to pause", "warning");
				return;
			}
			if (sub === "resume") {
				const g = loadGoal(sid);
				if (g && g.objective) {
					g.status = "active";
					g.updatedAt = Date.now();
					saveGoal(g);
					setDeferral(sid); // one turn, then wait for the user
					ctx.ui.notify(`pi-loop: goal resumed — ${g.objective}`, "info");
					kickoffTurn(pi, sid);
				} else ctx.ui.notify("pi-loop: no goal to resume", "warning");
				return;
			}
			if (sub === "clear") {
				deleteGoal(sid);
				clearDeferral(sid);
				ctx.ui.notify("pi-loop: goal cleared", "info");
				return;
			}
			// No argument: show the current goal summary (codex /goal, no args)
			if (!sub) {
				const g = loadGoal(sid);
				if (!g) {
					ctx.ui.notify("pi-loop: no goal. Usage: /goal <objective> [token_budget]", "info");
					return;
				}
				ctx.ui.notify(
					[
						`pi-loop goal (${statusLabel(g.status)})`,
						`objective: ${g.objective}`,
						`progress: ${g.turns} turns, ${g.tokensUsed} tokens${g.tokenBudget !== null ? ` / ${g.tokenBudget} budget` : ""}${g.timeUsedSeconds > 0 ? `, ${formatSeconds(g.timeUsedSeconds)} elapsed` : ""}`,
						`created: ${new Date(g.createdAt).toISOString()}`,
						`max turns: ${MAX_TURNS}`,
					].join("\n"),
					"info",
				);
				return;
			}
			// Anything else is the objective: /goal improve benchmark coverage
			const m = (args || "").trim().match(/^(.*?)\s+(\d+)\s*$/);
			const text = m ? m[1] : (args || "").trim();
			const budget = m ? Number(m[2]) : DEFAULT_BUDGET;
			setGoal(text, budget);
		},
	});
}

function textResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}
