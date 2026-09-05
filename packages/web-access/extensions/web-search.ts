/**
 * web_search: search the public web and return per-result summaries.
 *
 * Ported from mpa-agent's app/runtime/tools/web_search.py (which uses
 * veadk's ve_request).
 *
 * Credential resolution order (mirrors mpa-agent):
 *   1. TOOL_WEB_SEARCH_ACCESS_KEY / TOOL_WEB_SEARCH_SECRET_KEY
 *   2. VOLCENGINE_ACCESS_KEY / VOLCENGINE_SECRET_KEY
 *   3. IAM credential JSON: file at $VOLCENGINE_CREDENTIAL_FILE, or raw
 *      JSON in $IAM_CREDENTIAL (fields: access_key_id, secret_access_key,
 *      optional session_token)
 */

import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_COUNT = 5;
const MAX_COUNT = 50;
const REQUEST_TIMEOUT_MS = 60_000;

const HOST = "mercury.volcengineapi.com";
const SERVICE = "volc_torchlight_api";
const VERSION = "2025-01-01";
const REGION = "cn-beijing";

interface Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

interface WebResult {
	Title?: string;
	Url?: string;
	Summary?: string;
	Snippet?: string;
}

function loadIamCredentialJson(raw: string, source: string): Credentials {
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		throw new Error(`IAM credential JSON is not valid: ${source}`);
	}
	if (typeof payload !== "object" || payload === null) {
		throw new Error(`IAM credential JSON must be an object: ${source}`);
	}
	const record = payload as Record<string, unknown>;
	const text = (key: string): string => {
		const value = record[key];
		return typeof value === "string" ? value.trim() : "";
	};
	const accessKeyId = text("access_key_id");
	const secretAccessKey = text("secret_access_key");
	if (!accessKeyId || !secretAccessKey) {
		throw new Error(`IAM credential JSON missing access_key_id/secret_access_key: ${source}`);
	}
	return {
		accessKeyId,
		secretAccessKey,
		sessionToken: text("session_token") || undefined,
	};
}

function loadCredentials(): Credentials {
	const toolAk = process.env.TOOL_WEB_SEARCH_ACCESS_KEY;
	const toolSk = process.env.TOOL_WEB_SEARCH_SECRET_KEY;
	if (toolAk && toolSk) {
		return { accessKeyId: toolAk, secretAccessKey: toolSk };
	}

	const volcAk = process.env.VOLCENGINE_ACCESS_KEY;
	const volcSk = process.env.VOLCENGINE_SECRET_KEY;
	if (volcAk && volcSk) {
		return { accessKeyId: volcAk, secretAccessKey: volcSk };
	}

	const credentialFile = process.env.VOLCENGINE_CREDENTIAL_FILE;
	if (credentialFile && existsSync(credentialFile)) {
		return loadIamCredentialJson(readFileSync(credentialFile, "utf8"), credentialFile);
	}
	const iamEnv = process.env.IAM_CREDENTIAL?.trim();
	if (iamEnv) {
		return loadIamCredentialJson(iamEnv, "IAM_CREDENTIAL");
	}

	throw new Error(
		"Web search credentials missing. Set TOOL_WEB_SEARCH_ACCESS_KEY/SECRET_KEY, " +
			"VOLCENGINE_ACCESS_KEY/SECRET_KEY, VOLCENGINE_CREDENTIAL_FILE, or IAM_CREDENTIAL.",
	);
}

const sha256Hex = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");
const hmac = (key: Buffer | string, content: string): Buffer => createHmac("sha256", key).update(content, "utf8").digest();

function uriEscape(value: string): string {
	// Equivalent to Python quote(value, safe="-_.~").
	return encodeURIComponent(value)
		.replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normQuery(params: Record<string, string>): string {
	return Object.keys(params)
		.sort()
		.map((key) => `${uriEscape(key)}=${uriEscape(params[key])}`)
		.join("&");
}

function xDate(now: Date): string {
	return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Volcano SigV4 signed request, ported from veadk volcengine_sign.request(). */
async function veWebSearch(
	query: string,
	count: number,
	credentials: Credentials,
	signal?: AbortSignal,
): Promise<WebResult[]> {
	const body = JSON.stringify({
		Query: query,
		SearchType: "web",
		Count: count,
		NeedSummary: true,
	});
	const query_ = { Action: "WebSearch", Version: VERSION };
	const payloadHash = sha256Hex(body);
	const date = xDate(new Date());
	const shortDate = date.slice(0, 8);

	const contentType = "application/json";
	const headers: Record<string, string> = {
		Host: HOST,
		"X-Date": date,
		"X-Content-Sha256": payloadHash,
		"Content-Type": contentType,
	};
	if (credentials.sessionToken) {
		headers["X-Security-Token"] = credentials.sessionToken;
	}

	const signedHeaders = "content-type;host;x-content-sha256;x-date";
	const canonicalRequest = [
		"POST",
		"/",
		normQuery(query_),
		[
			`content-type:${contentType}`,
			`host:${HOST}`,
			`x-content-sha256:${payloadHash}`,
			`x-date:${date}`,
		].join("\n"),
		"",
		signedHeaders,
		payloadHash,
	].join("\n");

	const credentialScope = `${shortDate}/${REGION}/${SERVICE}/request`;
	const stringToSign = ["HMAC-SHA256", date, credentialScope, sha256Hex(canonicalRequest)].join("\n");

	const kDate = hmac(credentials.secretAccessKey, shortDate);
	const kRegion = hmac(kDate, REGION);
	const kService = hmac(kRegion, SERVICE);
	const kSigning = hmac(kService, "request");
	const signature = hmac(kSigning, stringToSign).toString("hex");
	headers.Authorization =
		`HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
		`SignedHeaders=${signedHeaders}, Signature=${signature}`;

	const url = `https://${HOST}/?${normQuery(query_)}`;
	const response = await fetch(url, {
		method: "POST",
		headers,
		body,
		signal: AbortSignal.any
			? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)].filter(Boolean) as AbortSignal[])
			: signal,
	});
	if (!response.ok) {
		throw new Error(`Web search HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
	}
	const payload = (await response.json()) as {
		ResponseMetadata?: { Error?: { Code?: string; CodeN?: number | string; Message?: string } };
		Result?: { WebResults?: WebResult[] };
	};
	const error = payload.ResponseMetadata?.Error;
	if (error) {
		const code = String(error.Code ?? error.CodeN ?? "").trim();
		throw new Error(`Web search failed: ${code ? `${code}: ` : ""}${String(error.Message ?? "")}`);
	}
	return payload.Result?.WebResults ?? [];
}

function formatResults(results: WebResult[]): string {
	const lines = results
		.map((result) => {
			const summary = (result.Summary ?? result.Snippet ?? "").trim();
			if (!summary) return "";
			const title = result.Title?.trim();
			const url = result.Url?.trim();
			const header = title ? (url ? `${title}\n${url}` : title) : (url ?? "");
			return header ? `${header}\n${summary}` : summary;
		})
		.filter((line): line is string => line.length > 0);
	if (lines.length === 0) return "No results found.";
	return lines.map((line, i) => `${i + 1}. ${line}`).join("\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the public web and return per-result summaries. " +
			"Use for web research questions; supports Chinese web coverage well.",
		promptSnippet: "Use for web search and web research questions.",
		parameters: Type.Object({
			query: Type.String({ description: "Required search query." }),
			count: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 50, description: "Number of results (default 5, max 50)." }),
			),
		}),
		async execute(_callId, params, signal) {
			const query = params.query.trim();
			if (!query) {
				return { content: [{ type: "text", text: "Error: query is required." }], details: { error: "query required" } };
			}
			const count = Math.max(1, Math.min(Math.floor(params.count ?? DEFAULT_COUNT), MAX_COUNT));
			try {
				const credentials = loadCredentials();
				const results = await veWebSearch(query, count, credentials, signal);
				return {
					content: [{ type: "text", text: formatResults(results) }],
					details: { query, count, resultCount: results.length },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Error: ${message}` }], details: { error: message } };
			}
		},
	});
}
