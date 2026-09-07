import { test } from "node:test";
import assert from "node:assert/strict";
import {
	extractTokenUsage,
	enforceLimits,
	statusLabel,
	formatSeconds,
	continuationMessage,
	parseGoalArgs,
} from "../packages/loop/lib/goal-core.cjs";

// --- extractTokenUsage：只算当轮增量，不算累计 totalTokens ---
test("extractTokenUsage sums per-request deltas, not cumulative totals", () => {
	const event = {
		messages: [
			{ usage: { input: 6804, output: 47, totalTokens: 6851 } },
			{ usage: { input: 871, output: 83, totalTokens: 7738 } },
			{ usage: { input: 317, output: 48, totalTokens: 7981 } },
		],
	};
	// 旧 bug：Σ totalTokens = 22570（历史重复累计）；正确 = Σ(input+output) = 8170
	assert.equal(extractTokenUsage(event), 8170);
});

test("extractTokenUsage handles missing usage", () => {
	assert.equal(extractTokenUsage({ messages: [{}, { usage: undefined }] }), 0);
	assert.equal(extractTokenUsage({ messages: [] }), 0);
});

// --- enforceLimits：预算耗尽 → budget_limited；轮数超限 → usage_limited ---
test("enforceLimits: budget exceeded flips to budget_limited", () => {
	const g = { status: "active", tokenBudget: 100, tokensUsed: 150, turns: 1 };
	assert.equal(enforceLimits(g), "budget_limited");
	assert.equal(g.status, "budget_limited");
});

test("enforceLimits: turn cap flips to usage_limited", () => {
	const g = { status: "active", tokenBudget: null, tokensUsed: 50, turns: 20 };
	assert.equal(enforceLimits(g, 20), "usage_limited");
});

test("enforceLimits: within limits stays active", () => {
	const g = { status: "active", tokenBudget: 100, tokensUsed: 50, turns: 5 };
	assert.equal(enforceLimits(g, 20), "active");
});

test("enforceLimits: non-active goal unchanged", () => {
	const g = { status: "complete", tokenBudget: 1, tokensUsed: 999, turns: 99 };
	assert.equal(enforceLimits(g, 20), "complete");
});

// --- statusLabel ---
test("statusLabel formats underscore statuses", () => {
	assert.equal(statusLabel("budget_limited"), "BUDGET LIMITED");
	assert.equal(statusLabel("active"), "ACTIVE");
});

// --- formatSeconds ---
test("formatSeconds renders durations", () => {
	assert.equal(formatSeconds(45), "45s");
	assert.equal(formatSeconds(125), "2m 5s");
	assert.equal(formatSeconds(3700), "1h 1m");
});

// --- continuationMessage 包含目标与进度 ---
test("continuationMessage embeds objective and progress", () => {
	const g = { objective: "测试", tokenBudget: 50000, tokensUsed: 100, turns: 2, timeUsedSeconds: 0 };
	const msg = continuationMessage(g);
	assert.match(msg, /<goal objective="测试">/);
	assert.match(msg, /2 turns \/ 100\/50000 tokens/);
});

// --- parseGoalArgs：codex 用法 /goal [<objective>|clear|edit|pause|resume] ---
test("parseGoalArgs: bare text is the objective (codex form)", () => {
	const r = parseGoalArgs("improve benchmark coverage");
	assert.equal(r.action, "set-objective");
	assert.equal(r.objective, "improve benchmark coverage");
	assert.equal(r.budget, 100000); // default budget
});

test("parseGoalArgs: trailing number is an explicit budget (pi extension)", () => {
	const r = parseGoalArgs("改进测试覆盖率 50000");
	assert.equal(r.objective, "改进测试覆盖率");
	assert.equal(r.budget, 50000);
});

test("parseGoalArgs: no args → summary", () => {
	assert.equal(parseGoalArgs("").action, "summary");
});

test("parseGoalArgs: subcommands", () => {
	assert.equal(parseGoalArgs("clear").action, "clear");
	assert.equal(parseGoalArgs("pause").action, "pause");
	assert.equal(parseGoalArgs("resume").action, "resume");
	assert.equal(parseGoalArgs("edit fix the flaky test").action, "edit");
	assert.equal(parseGoalArgs("edit fix the flaky test").objective, "fix the flaky test");
});

test("parseGoalArgs: set/edit with empty objective errors", () => {
	assert.equal(parseGoalArgs("set").error, "objective required");
});
