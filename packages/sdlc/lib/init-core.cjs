"use strict";

function parseInitArgs(input = "") {
	const tokens = String(input).trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { force: false };
	if (tokens.length === 1 && tokens[0] === "--force") return { force: true };
	return { error: "usage: /init [--force]" };
}

function initMode(agentsExists, force) {
	if (!agentsExists) return "create";
	return force ? "replace" : "update";
}

function buildInitPrompt({ agentsPath, mode }) {
	const action = mode === "create"
		? `Create ${agentsPath}.`
		: mode === "replace"
			? `Replace ${agentsPath} with a fresh, project-specific version.`
			: `Update ${agentsPath} in place. Preserve existing human-authored rules unless they are demonstrably stale or contradicted by current project evidence.`;

	return `Initialize this repository for pi, matching Codex /init semantics.

${action}

First perform a READ-ONLY reconnaissance of the current project. Inspect the repository files and configuration to establish facts. Do not guess commands, architecture, conventions, ownership, or safety rules.

Then write a concise, useful AGENTS.md for future pi agents. It must be specific to this repository and include, when evidence exists:
- what the project is and its important directory/package boundaries;
- verified setup, build, test, lint, format, typecheck, and run commands (include expected healthy output when useful);
- coding, testing, dependency, generated-file, and security/secret conventions;
- important architecture, integration, and validation constraints;
- a short "Things pi gets wrong" section only for verified recurring pitfalls.

Requirements:
- Write ONLY ${agentsPath}; do not create, rename, or modify CLAUDE.md.
- Keep AGENTS.md actionable and compact; link to existing project documentation instead of duplicating it.
- Mark unknown information as "not established" or omit it. Never invent commands, policies, dependencies, owners, or CI behavior.
- Do not edit source code, dependencies, lockfiles, settings, or unrelated files.
- Before finishing, re-read the written AGENTS.md and report the evidence used and the exact file changed.`;
}

module.exports = { parseInitArgs, initMode, buildInitPrompt };
