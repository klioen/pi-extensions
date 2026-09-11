"use strict";

const LARK_SKILL_PREFIX = "lark-";
const LARK_SKILL_BLOCK = /\n?\s*<skill>(?:(?!<\/skill>)[\s\S])*?<name>\s*lark-[^<]*<\/name>(?:(?!<\/skill>)[\s\S])*?<\/skill>/g;

function parseLarkArgs(input = "") {
	const value = String(input).trim();
	if (!value) return { action: "on" };
	if (value === "off" || value === "status") return { action: value };
	return { action: "request", request: value };
}

function isLarkSkill(value) {
	return Boolean(value && typeof value === "object" && typeof value.name === "string" && value.name.startsWith(LARK_SKILL_PREFIX));
}

function filterLarkSkills(skills) {
	return Array.isArray(skills) ? skills.filter((skill) => !isLarkSkill(skill)) : [];
}

function filterLarkSkillsFromPrompt(prompt) {
	if (typeof prompt !== "string") return prompt;
	return prompt.replace(LARK_SKILL_BLOCK, "");
}

function normalizeLarkState(value) {
	return { enabled: Boolean(value && typeof value === "object" && value.enabled === true) };
}

function buildLarkPrompt(enabled) {
	return enabled
		? "CURRENT LARK MODE: ON. The lark-* skills listed in the system prompt are available for automatic routing."
		: "CURRENT LARK MODE: OFF. The lark-* skills are not available for automatic routing. Ask the user to run /lark before relying on them.";
}

module.exports = {
	LARK_SKILL_PREFIX,
	buildLarkPrompt,
	filterLarkSkills,
	filterLarkSkillsFromPrompt,
	isLarkSkill,
	normalizeLarkState,
	parseLarkArgs,
};
