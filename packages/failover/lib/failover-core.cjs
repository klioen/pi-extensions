/**
 * Pure failover-domain logic for pi-failover. Plain CommonJS so the
 * jiti-loaded extension and node:test can both require it without TS
 * transformation.
 */

/** Parse the API key pool from env (ARK_API_KEYS csv + ARK_API_KEY[_N]). */
function readKeys(env) {
	const keys = [];
	const csv = env.ARK_API_KEYS;
	if (csv) {
		for (const part of csv.split(",")) {
			const k = part.trim();
			if (k) keys.push(k);
		}
	}
	if (env.ARK_API_KEY) keys.push(env.ARK_API_KEY);
	for (let i = 2; i <= 50; i++) {
		const k = env[`ARK_API_KEY_${i}`];
		if (k) keys.push(k);
		else break;
	}
	return [...new Set(keys)];
}

/** Detect rate-limit / quota messages from the provider. */
function isRateLimitMessage(message) {
	if (!message) return false;
	return /429|TooManyRequests|AccountQuotaExceeded|quota.{0,20}(exceeded|limit)|rate.?limit/i.test(message);
}

/**
 * Round-robin key selector with per-key cooldown.
 * Stateful: keeps internal cursor + cooldown map.
 */
function createKeyPicker() {
	let cursor = 0;
	const cooldown = new Map();

	function pickKey(keys, now) {
		if (keys.length === 0) return undefined;
		for (let i = 0; i < keys.length; i++) {
			const key = keys[(cursor + i) % keys.length];
			if ((cooldown.get(key) ?? 0) <= now) {
				cursor = (cursor + i + 1) % keys.length;
				return key;
			}
		}
		// All keys cooling down: fall back to the least-recently-cooled one.
		cursor = (cursor + 1) % keys.length;
		return keys[cursor];
	}

	function coolDown(key, until) {
		cooldown.set(key, until);
	}

	return { pickKey, coolDown };
}

module.exports = { readKeys, isRateLimitMessage, createKeyPicker };
