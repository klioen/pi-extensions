/**
 * Pure goal-domain logic for pi-loop. Plain CommonJS so the jiti-loaded
 * extension and node:test can both require it without TS transformation.
 */

/**
 * Sum the per-request token cost of a run's messages.
 * usage.totalTokens is cumulative across turns; input/output are per-request
 * deltas. Summing totalTokens double-counts history.
 */
function extractTokenUsage(event) {
	let total = 0;
	for (const m of event.messages || []) {
		const u = m.usage;
		if (u) total += (u.input ?? 0) + (u.output ?? 0);
	}
	return total;
}

/**
 * Apply budget/limits after accounting. Mutates g.status; returns it.
 * maxTurns mirrors PI_LOOP_MAX_TURNS (default 20).
 */
function enforceLimits(g, maxTurns = 20) {
	if (g.status !== "active") return g.status;
	if (g.tokenBudget !== null && g.tokensUsed >= g.tokenBudget) {
		g.status = "budget_limited";
	} else if (g.turns >= maxTurns) {
		g.status = "usage_limited";
	}
	return g.status;
}

function statusLabel(s) {
	return s.replace("_", " ").toUpperCase();
}

function formatSeconds(seconds) {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

/** Codex continuation_prompt steering text. */
function continuationMessage(g) {
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

/**
 * Parse /goal command args (Codex usage: /goal [<objective>|clear|edit|pause|resume]).
 * Returns { action, objective, budget } where action is one of
 * "set" | "edit" | "pause" | "resume" | "clear" | "summary" | "set-objective",
 * and budget is a number or null (trailing number on the objective is an
 * explicit token budget — pi extension).
 */
function parseGoalArgs(args, defaultBudget = 100000) {
	const parts = (args || "").trim().split(/\s+/);
	const sub = (parts[0] || "").toLowerCase();
	if (sub === "set" || sub === "edit" || sub === "pause" || sub === "resume" || sub === "clear") {
		const objective = (args || "").slice(parts[0].length).trim();
		if ((sub === "set" || sub === "edit") && !objective) {
			return { action: sub, objective: "", budget: null, error: "objective required" };
		}
		if (sub === "set" || sub === "edit") {
			const m = objective.match(/^(.*?)\s+(\d+)\s*$/);
			return {
				action: sub,
				objective: m ? m[1] : objective,
				budget: m ? Number(m[2]) : defaultBudget,
			};
		}
		return { action: sub, objective: "", budget: null };
	}
	if (!sub) return { action: "summary", objective: "", budget: null };
	// Anything else is the objective (Codex usage)
	const m = (args || "").trim().match(/^(.*?)\s+(\d+)\s*$/);
	return {
		action: "set-objective",
		objective: m ? m[1] : (args || "").trim(),
		budget: m ? Number(m[2]) : defaultBudget,
	};
}

module.exports = {
	extractTokenUsage,
	enforceLimits,
	statusLabel,
	formatSeconds,
	continuationMessage,
	parseGoalArgs,
};
