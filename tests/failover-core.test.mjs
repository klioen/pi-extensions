import { test } from "node:test";
import assert from "node:assert/strict";
import {
	readKeys,
	isRateLimitMessage,
	createKeyPicker,
} from "../packages/failover/lib/failover-core.cjs";

// --- readKeys：csv + ARK_API_KEY[_N] + 去重 ---
test("readKeys parses csv and numbered keys, dedupes", () => {
	const env = {
		ARK_API_KEYS: " key1, key2 ,key1 ",
		ARK_API_KEY: "key3",
		ARK_API_KEY_2: "key4",
		ARK_API_KEY_3: "key5",
	};
	const keys = readKeys(env);
	assert.deepEqual(keys, ["key1", "key2", "key3", "key4", "key5"]);
});

test("readKeys empty env → empty array", () => {
	assert.deepEqual(readKeys({}), []);
});

// --- isRateLimitMessage：429/配额/限流检测 ---
test("isRateLimitMessage detects 429 and quota messages", () => {
	assert.equal(isRateLimitMessage("HTTP 429 Too Many Requests"), true);
	assert.equal(isRateLimitMessage("TooManyRequests"), true);
	assert.equal(isRateLimitMessage("AccountQuotaExceeded"), true);
	assert.equal(isRateLimitMessage("quota exceeded for model"), true);
	assert.equal(isRateLimitMessage("rate limit reached"), true);
});

test("isRateLimitMessage ignores normal errors", () => {
	assert.equal(isRateLimitMessage("invalid api key"), false);
	assert.equal(isRateLimitMessage(undefined), false);
	assert.equal(isRateLimitMessage(""), false);
});

// --- createKeyPicker：轮换 + 冷却 ---
test("pickKey round-robins through keys", () => {
	const picker = createKeyPicker();
	const keys = ["a", "b", "c"];
	assert.equal(picker.pickKey(keys, 1000), "a");
	assert.equal(picker.pickKey(keys, 1000), "b");
	assert.equal(picker.pickKey(keys, 1000), "c");
	assert.equal(picker.pickKey(keys, 1000), "a"); // wraps
});

test("pickKey skips cooling-down keys", () => {
	const picker = createKeyPicker();
	const keys = ["a", "b", "c"];
	assert.equal(picker.pickKey(keys, 1000), "a");
	picker.coolDown("b", 2000); // b 冷却到 2000
	assert.equal(picker.pickKey(keys, 1500), "c"); // 跳过 b
	// 全部冷却时回退
	picker.coolDown("a", 9999);
	picker.coolDown("c", 9999);
	const fallback = picker.pickKey(keys, 1500);
	assert.ok(["a", "b", "c"].includes(fallback), "falls back to a key");
});

test("pickKey empty keys → undefined", () => {
	const picker = createKeyPicker();
	assert.equal(picker.pickKey([], 1000), undefined);
});
