import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInitPrompt, initMode, parseInitArgs } from "../packages/plan/lib/init-core.cjs";

test("parseInitArgs accepts default and force modes", () => {
	assert.deepEqual(parseInitArgs(""), { force: false });
	assert.deepEqual(parseInitArgs("--force"), { force: true });
	assert.equal(parseInitArgs("--bad").error, "usage: /init [--force]");
	assert.equal(parseInitArgs("--force extra").error, "usage: /init [--force]");
});

test("initMode protects existing AGENTS.md unless forced", () => {
	assert.equal(initMode(false, false), "create");
	assert.equal(initMode(true, false), "update");
	assert.equal(initMode(true, true), "replace");
});

test("create prompt requires evidence-based AGENTS.md initialization", () => {
	const prompt = buildInitPrompt({ agentsPath: "/workspace/AGENTS.md", mode: "create" });
	assert.match(prompt, /Create \/workspace\/AGENTS\.md/);
	assert.match(prompt, /READ-ONLY reconnaissance/);
	assert.match(prompt, /Never invent commands/);
	assert.match(prompt, /build, test, lint, format, typecheck/);
	assert.match(prompt, /Write ONLY \/workspace\/AGENTS\.md/);
	assert.match(prompt, /do not create, rename, or modify CLAUDE\.md/);
});

test("update prompt preserves existing human-authored instructions", () => {
	const prompt = buildInitPrompt({ agentsPath: "AGENTS.md", mode: "update" });
	assert.match(prompt, /Update AGENTS\.md in place/);
	assert.match(prompt, /Preserve existing human-authored rules/);
});

test("force prompt explicitly permits project-specific replacement", () => {
	const prompt = buildInitPrompt({ agentsPath: "AGENTS.md", mode: "replace" });
	assert.match(prompt, /Replace AGENTS\.md with a fresh, project-specific version/);
});
