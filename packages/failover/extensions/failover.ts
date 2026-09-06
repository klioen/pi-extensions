/**
 * pi-failover: automatic multi-API-key failover for OpenAI-compatible
 * providers (default: ark), without any proxy in the middle.
 *
 * When a key hits a rate-limit (HTTP 429 / AccountQuotaExceeded /
 * TooManyRequests / quota …) *before any token is produced*, the extension
 * transparently retries the same request with the next key. Keys that are
 * rate-limited are put on a short cooldown so they are skipped for a while.
 *
 * This works by overriding the provider's `streamSimple`: the official
 * `openai-completions` stream is invoked per-key, and its events are forwarded
 * live (no buffering), so the caller still sees real streaming. Because a
 * provider 429 is returned *before* the response body, a rate-limited attempt
 * never emits content — the extension only swaps keys when nothing has been
 * forwarded yet, making the switch invisible.
 *
 * Config (env):
 *   ARK_API_KEYS            comma-separated key pool (highest priority)
 *   ARK_API_KEY             first key (fallback)
 *   ARK_API_KEY_2 … _N      additional keys (fallback)
 *   PI_FAILOVER_PROVIDER    provider to override (default "ark")
 *   PI_FAILOVER_COOLDOWN_MS rate-limited key cooldown (default 60000)
 *
 * Only activates when at least two keys are configured; otherwise the
 * provider is left untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple as baseStreamSimple } from "@earendil-works/pi-ai/compat";

const PROVIDER = process.env.PI_FAILOVER_PROVIDER || "ark";
const COOLDOWN_MS = Number(process.env.PI_FAILOVER_COOLDOWN_MS) || 60_000;

function readKeys(): string[] {
	const keys: string[] = [];
	const csv = process.env.ARK_API_KEYS;
	if (csv) {
		for (const part of csv.split(",")) {
			const k = part.trim();
			if (k) keys.push(k);
		}
	}
	if (process.env.ARK_API_KEY) keys.push(process.env.ARK_API_KEY);
	for (let i = 2; i <= 50; i++) {
		const k = process.env[`ARK_API_KEY_${i}`];
		if (k) keys.push(k);
		else break;
	}
	return [...new Set(keys)];
}

function isRateLimitMessage(message: string | undefined): boolean {
	if (!message) return false;
	return /429|TooManyRequests|AccountQuotaExceeded|quota.{0,20}(exceeded|limit)|rate.?limit/i.test(message);
}

// Key → epoch ms until which it should be skipped.
const cooldown = new Map<string, number>();
let cursor = 0;

function pickKey(keys: string[], now: number): string {
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

const baseApi = { streamSimple: baseStreamSimple };

function failoverStream(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();

	(async () => {
		const keys = readKeys();
		let lastRateLimitEvent: AssistantMessageEvent | undefined;
		let lastErrorText = "all API keys are rate-limited";
		let ended = false;
		const end = (event?: AssistantMessageEvent) => {
			if (ended) return;
			ended = true;
			if (event) out.push(event);
			out.end();
		};

		for (let attempt = 0; attempt < Math.max(keys.length, 1); attempt++) {
			const key = keys.length > 0 ? pickKey(keys, Date.now()) : "";
			const sub = baseApi.streamSimple(
				model,
				context,
				options ? { ...options, apiKey: key } : ({ apiKey: key } as SimpleStreamOptions),
			);
			let forwardedNonStart = false;
			let rateLimited = false;

			try {
				for await (const ev of sub) {
					if (ev.type === "error") {
						const msg = (ev as { error?: { errorMessage?: string } }).error?.errorMessage ?? "";
						if (!forwardedNonStart && isRateLimitMessage(msg)) {
							rateLimited = true;
							lastRateLimitEvent = ev;
							lastErrorText = msg;
							cooldown.set(key, Date.now() + COOLDOWN_MS);
							break;
						}
						end(ev);
						return;
					}
					if (ev.type !== "start") forwardedNonStart = true;
					out.push(ev);
				}
				if (!rateLimited) {
					end();
					return;
				}
				// rate-limited before any content → try next key
			} catch (err) {
				lastErrorText = err instanceof Error ? err.message : String(err);
				if (ended) return;
			}
		}

		if (lastRateLimitEvent) {
			end(lastRateLimitEvent);
		} else {
			end({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: lastErrorText,
					timestamp: Date.now(),
				},
			});
		}
	})().catch((err) => {
		try {
			out.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: err instanceof Error ? err.message : String(err),
					timestamp: Date.now(),
				},
			});
			out.end();
		} catch {
			/* stream already ended */
		}
	});

	return out;
}

export default function (pi: ExtensionAPI) {
	const keys = readKeys();
	if (keys.length < 2) return; // leave the provider alone when there is nothing to fail over

	pi.registerProvider(PROVIDER, {
		api: "openai-completions",
		streamSimple: failoverStream,
	});

	let notified = false;
	pi.on("session_start", async (_event, ctx) => {
		if (notified) return;
		notified = true;
		ctx.ui.notify(`pi-failover: ${keys.length} API keys pooled for provider "${PROVIDER}".`, "info");
	});
}