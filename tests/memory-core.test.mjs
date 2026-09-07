import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, phase1Prompt, parseJsonObj, repairJsonText } from "../packages/memory/lib/memory-core.cjs";

// --- SCHEMA：包含 jobs + stage1_outputs 表 ---
test("SCHEMA defines jobs and stage1_outputs tables", () => {
	assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS jobs/);
	assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS stage1_outputs/);
	assert.match(SCHEMA, /input_watermark INTEGER/); // codex watermark 幂等字段
});

// --- phase1Prompt：包含 transcript 和提取指令 ---
test("phase1Prompt embeds the transcript", () => {
	const prompt = phase1Prompt("hello world", "/tmp/rollout.jsonl", "/tmp");
	assert.match(prompt, /hello world/);
	assert.match(prompt, /\/tmp\/rollout\.jsonl/);
});

// --- repairJsonText：修复模型输出里的损坏 JSON ---
test("repairJsonText fixes common truncation damage", () => {
	// 未闭合的对象
	const repaired = repairJsonText('{"a": 1, "b": {"c": 2');
	assert.match(repaired, /"a":\s*1/);
	assert.match(repaired, /"c":\s*2/);
});

test("repairJsonText removes trailing commas before closers", () => {
	const repaired = repairJsonText('{"a": [1, 2,], "b": 1,}');
	assert.match(repaired, /"a":\s*\[1,\s*2\]/);
	assert.equal(repaired.includes(",]"), false);
	assert.equal(repaired.includes(",}"), false);
});

test("repairJsonText converts single quotes and bare keys", () => {
	const repaired = repairJsonText("{'a': 'v', b: 1}");
	assert.match(repaired, /"a":\s*"v"/);
	assert.match(repaired, /"b":\s*1/);
});

// --- parseJsonObj：容忍代码块围栏和前后噪音 ---
test("parseJsonObj strips markdown fences", () => {
	const obj = parseJsonObj('```json\n{"key": "value"}\n```');
	assert.deepEqual(obj, { key: "value" });
});

test("parseJsonObj returns null on hopeless input", () => {
	assert.equal(parseJsonObj("totally not json"), null);
});

test("parseJsonObj parses plain json", () => {
	assert.deepEqual(parseJsonObj('{"n": 42}'), { n: 42 });
});
