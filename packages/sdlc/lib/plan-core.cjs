"use strict";

const PLAN_TOOLS = ["read", "grep", "find", "ls", "bash"];
const SHELL_CONTROL = /[|;&><`\n\r]|\$\(|\$\{/;

function parsePlanArgs(input = "") {
	const tokens = String(input).trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { action: "on" };
	if (tokens.length === 1 && tokens[0] === "off") return { action: "off" };
	if (tokens.length === 1 && tokens[0] === "status") return { action: "status" };
	return { error: "usage: /plan [off|status]" };
}

function tokens(command) {
	return command.trim().split(/\s+/).filter(Boolean);
}

function isReadOnlyBashCommand(command) {
	if (typeof command !== "string" || !command.trim() || SHELL_CONTROL.test(command)) return false;
	const parts = tokens(command);
	const [program, ...args] = parts;
	if (!program) return false;

	if (["cat", "head", "tail", "wc", "stat", "file", "pwd", "ls", "find", "rg", "grep", "diff", "du"].includes(program)) return true;
	if (program === "sed") return args[0] === "-n";
	if (program === "node") return args.length === 1 && args[0] === "--version";
	if (program === "git") {
		const subcommand = args[0];
		if (["status", "log", "diff", "show", "branch", "remote", "ls-files"].includes(subcommand)) return true;
		return subcommand === "config" && (args[1] === "--get" || args[1] === "--get-regexp");
	}
	if (program === "npm") return (args.length === 1 && args[0] === "--version") || ["list", "ls", "view", "info", "outdated", "audit"].includes(args[0]);
	return false;
}

function normalizePlanState(value) {
	if (!value || typeof value !== "object") return { enabled: false, toolsBeforePlanMode: undefined };
	const tools = Array.isArray(value.toolsBeforePlanMode) && value.toolsBeforePlanMode.every((x) => typeof x === "string")
		? [...new Set(value.toolsBeforePlanMode)]
		: undefined;
	return { enabled: value.enabled === true, toolsBeforePlanMode: tools };
}

function buildPlanPrompt() {
	return `You are in PLAN MODE: collaborate on a plan, but do not execute it.

You may inspect the repository using only read-only tools. First gather evidence, then ask concise clarifying questions when needed. Do not modify files. Do not create plan.md. Do not install dependencies, run tests, start services, make network requests, commit, push, or otherwise execute the proposed work.

Return a reviewable plan with exactly these sections when applicable:
1. Understanding and evidence
2. Scope and files likely to change
3. Proposed implementation steps
4. Risks, alternatives, and decision points
5. Verification approach
6. Open questions

Treat the plan as a proposal only. Leaving plan mode, a user acknowledgement, or continued conversation does not constitute approval to implement. Implementation still requires the repository's documented planning and explicit-approval workflow.`;
}

module.exports = { PLAN_TOOLS, parsePlanArgs, isReadOnlyBashCommand, normalizePlanState, buildPlanPrompt };
