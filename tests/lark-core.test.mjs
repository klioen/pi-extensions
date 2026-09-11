import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildLarkPrompt,
	filterLarkSkills,
	filterLarkSkillsFromPrompt,
	isLarkSkill,
	normalizeLarkState,
	parseLarkArgs,
} from "../packages/lark/lib/lark-core.cjs";

test("parses lark mode commands and inline requests", () => {
	assert.deepEqual(parseLarkArgs(""), { action: "on" });
	assert.deepEqual(parseLarkArgs("   "), { action: "on" });
	assert.deepEqual(parseLarkArgs("off"), { action: "off" });
	assert.deepEqual(parseLarkArgs(" status "), { action: "status" });
	assert.deepEqual(parseLarkArgs("查看今天日程"), { action: "request", request: "查看今天日程" });
	assert.deepEqual(parseLarkArgs("off please"), { action: "request", request: "off please" });
});

test("recognizes only lark-prefixed skill names", () => {
	for (const name of ["lark-doc", "lark-shared", "lark-workflow-standup-report"]) {
		assert.equal(isLarkSkill({ name }), true, name);
	}
	for (const value of [{ name: "sdlc-build" }, { name: "my-lark-doc" }, { name: "Lark-doc" }, {}, null]) {
		assert.equal(isLarkSkill(value), false, JSON.stringify(value));
	}
});

test("filters lark skills without mutating the source list", () => {
	const skills = [
		{ name: "sdlc-build", description: "build" },
		{ name: "lark-doc", description: "docs" },
		{ name: "todo", description: "todo" },
	];
	const filtered = filterLarkSkills(skills);
	assert.deepEqual(filtered.map((skill) => skill.name), ["sdlc-build", "todo"]);
	assert.equal(skills.length, 3);
	assert.notEqual(filtered, skills);
	assert.deepEqual(filterLarkSkills(undefined), []);
});

test("removes only lark skill XML blocks from a built system prompt", () => {
	const prompt = `header
<available_skills>
  <skill>
    <name>sdlc-build</name>
    <description>build</description>
    <location>/skills/sdlc-build/SKILL.md</location>
  </skill>
  <skill>
    <name>lark-doc</name>
    <description>docs</description>
    <location>/skills/lark-doc/SKILL.md</location>
  </skill>
</available_skills>
footer`;
	const filtered = filterLarkSkillsFromPrompt(prompt);
	assert.match(filtered, /sdlc-build/);
	assert.doesNotMatch(filtered, /lark-doc/);
	assert.match(filtered, /footer/);
});

test("normalizes persisted state conservatively", () => {
	assert.deepEqual(normalizeLarkState({ enabled: true }), { enabled: true });
	assert.deepEqual(normalizeLarkState({ enabled: false }), { enabled: false });
	assert.deepEqual(normalizeLarkState({ enabled: "true" }), { enabled: false });
	assert.deepEqual(normalizeLarkState(null), { enabled: false });
});

test("mode prompts state the current routing behavior", () => {
	assert.match(buildLarkPrompt(true), /LARK MODE: ON/);
	assert.match(buildLarkPrompt(true), /lark-/);
	assert.match(buildLarkPrompt(false), /LARK MODE: OFF/);
	assert.match(buildLarkPrompt(false), /not available/i);
});
