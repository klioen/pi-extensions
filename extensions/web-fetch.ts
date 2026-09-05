/**
 * web_fetch: fetch content from a URL as text, markdown, html, or an image
 * attachment. Ported from mpa-agent's app/runtime/tools/web_fetch.py
 * (itself modeled after opencode's webfetch tool).
 *
 * Notable behaviors:
 * - SSRF protection: http(s) only, host must not resolve to private /
 *   loopback / link-local / reserved / multicast addresses; internal
 *   metadata hostnames are rejected. Every redirect hop is re-validated.
 * - Manual redirect following (max 5), size cap 5MB, timeout 30s (max 120s).
 * - Cloudflare challenge (403 + cf-mitigated: challenge) retries once with
 *   a plain "opencode" user agent.
 * - HTML to markdown/text conversion via a dependency-free tag pass.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_REDIRECTS = 5;
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const BLOCKED_HOSTS = new Set([
	"localhost",
	"metadata",
	"metadata.google.internal",
	"metadata.tencentyun.com",
]);

type FetchFormat = "text" | "markdown" | "html";

function isBlockedIPv4(ip: string): boolean {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
	const [a, b] = parts;
	return (
		a === 0 || // 0.0.0.0/8 "this network"
		a === 10 || // private
		a === 127 || // loopback
		(a === 100 && b >= 64 && b <= 127) || // shared address space
		(a === 169 && b === 254) || // link-local
		(a === 172 && b >= 16 && b <= 31) || // private
		(a === 192 && b === 168) || // private
		(a === 192 && b === 0) || // 192.0.0.0/24 + 192.0.2.0/24 reserved
		(a >= 224 && a <= 239) || // multicast
		a >= 240 // reserved + broadcast
	);
}

function isBlockedIPv6(ip: string): boolean {
	const lowered = ip.toLowerCase();
	const first = parseInt(lowered.split(":")[0] || "0", 16) || 0;
	if (lowered === "::" || lowered === "::1") return true; // unspecified, loopback
	if (first === 0xff) return true; // multicast ff00::/8
	if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
	if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
	// IPv4-mapped ::ffff:a.b.c.d
	const mapped = lowered.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return isBlockedIPv4(mapped[1]);
	return false;
}

function isBlockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return isBlockedIPv4(address);
	if (family === 6) return isBlockedIPv6(address);
	return true;
}

async function validatePublicUrl(rawUrl: string): Promise<URL> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl.trim());
	} catch {
		throw new Error("Invalid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("URL must start with http:// or https://");
	}
	const host = parsed.hostname.trim().toLowerCase();
	if (!host) throw new Error("URL is missing a host");
	if (BLOCKED_HOSTS.has(host) || host.endsWith(".metadata.internal") || host.endsWith(".internal")) {
		throw new Error("URL resolves to a blocked internal address");
	}
	if (isIP(host)) {
		if (isBlockedAddress(host)) throw new Error("URL resolves to a blocked internal address");
		return parsed;
	}
	let addresses: { address: string }[];
	try {
		addresses = await lookup(host, { all: true });
	} catch {
		throw new Error(`URL host could not be resolved: ${host}`);
	}
	if (addresses.length === 0) throw new Error(`URL host could not be resolved: ${host}`);
	if (addresses.some((entry) => isBlockedAddress(entry.address))) {
		throw new Error("URL resolves to a blocked internal address");
	}
	return parsed;
}

function acceptHeader(format: FetchFormat): string {
	if (format === "markdown") {
		return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
	}
	if (format === "text") {
		return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
	}
	return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
}

function headers(format: FetchFormat, userAgent = USER_AGENT): Record<string, string> {
	return {
		"User-Agent": userAgent,
		Accept: acceptHeader(format),
		"Accept-Language": "en-US,en;q=0.9",
	};
}

interface FetchedResponse {
	contentType: string;
	bytes: Uint8Array;
}

async function fetchResponse(
	url: string,
	format: FetchFormat,
	timeoutSeconds: number,
	signal?: AbortSignal,
): Promise<FetchedResponse> {
	let currentUrl = url;
	const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
	const requestSignal = AbortSignal.any(
		signal ? [signal, timeoutSignal] : [timeoutSignal],
	);
	for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
		const validated = await validatePublicUrl(currentUrl);
		let response = await fetch(validated, {
			headers: headers(format),
			redirect: "manual",
			signal: requestSignal,
		});
		if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
			response = await fetch(validated, {
				headers: headers(format, "opencode"),
				redirect: "manual",
				signal: requestSignal,
			});
		}
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			if (!location) throw new Error(`Redirect without Location header (HTTP ${response.status})`);
			if (redirectCount === MAX_REDIRECTS) throw new Error("too many redirects");
			currentUrl = new URL(location, currentUrl).toString();
			continue;
		}
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
		const contentLength = Number(response.headers.get("content-length") ?? 0);
		if (contentLength > MAX_RESPONSE_SIZE) throw new Error("Response too large (exceeds 5MB limit)");
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_RESPONSE_SIZE) throw new Error("Response too large (exceeds 5MB limit)");
		return { contentType: response.headers.get("content-type") ?? "", bytes };
	}
	throw new Error("too many redirects");
}

/** Decode HTML entities for the handful that matter in extracted text. */
function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'");
}

function stripInvisibleBlocks(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
}

/** Extract plain text from HTML (drops all markup). */
function extractTextFromHtml(html: string): string {
	return decodeEntities(stripInvisibleBlocks(html).replace(/<[^>]+>/g, " "))
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
}

/**
 * Convert HTML to markdown with sequential tag passes. Dependency-free, so
 * it covers the common structural tags (headings, links, lists, code,
 * emphasis, paragraphs) rather than a full DOM walk like the Python
 * BeautifulSoup version it ports.
 */
function convertHtmlToMarkdown(html: string): string {
	let out = stripInvisibleBlocks(html);
	out = out.replace(/<(br|BR)\s*\/?>/g, "\n");
	out = out.replace(/<hr[^>]*>/gi, "\n\n---\n\n");
	out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\n\`\`\`\n${extractTextFromHtml(code)}\n\`\`\`\n\n`);
	out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code: string) => `\`${decodeEntities(code.replace(/<[^>]+>/g, "")).trim()}\``);
	out = out.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, text: string) => `\n\n${"#".repeat(Number(level))} ${extractTextFromHtml(text)}\n\n`);
	out = out.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
		const label = extractTextFromHtml(text);
		return label && href ? `[${label}](${href})` : label;
	});
	out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, text: string) => {
		const label = extractTextFromHtml(text);
		return label ? `**${label}**` : "";
	});
	out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, text: string) => {
		const label = extractTextFromHtml(text);
		return label ? `*${label}*` : "";
	});
	out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, text: string) => `\n- ${extractTextFromHtml(text)}`);
	out = out.replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n");
	out = out.replace(/<\/?(p|div|section|article|main|body|html|blockquote|table|tr|td|th|header|footer|nav|aside|figure|figcaption)\b[^>]*>/gi, "\n\n");
	// Drop every remaining tag, decode entities, and collapse whitespace runs.
	out = decodeEntities(out.replace(/<[^>]+>/g, ""));
	out = out
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.reduce<string[]>((acc, line) => {
			if (line === "" && acc[acc.length - 1] === "") return acc;
			acc.push(line);
			return acc;
		}, [])
		.join("\n")
		.trim();
	return out;
}

function charsetFromContentType(contentType: string): string {
	const match = contentType.match(/charset=["']?([^;"']+)/i);
	return match ? match[1].trim() : "";
}

function charsetFromHtmlMeta(content: Uint8Array): string {
	const head = Buffer.from(content.slice(0, 4096)).toString("ascii");
	const match = head.match(/<meta[^>]+charset=["']?\s*([^"'\s/>;]+)/i);
	return match ? match[1].trim() : "";
}

function decodeBody(contentType: string, bytes: Uint8Array): string {
	const buffer = Buffer.from(bytes);
	for (const encoding of [charsetFromContentType(contentType), charsetFromHtmlMeta(bytes), "utf-8"]) {
		if (!encoding) continue;
		try {
			return buffer.toString(encoding as BufferEncoding);
		} catch {
			// Unsupported encoding label; try the next candidate.
		}
	}
	return buffer.toString("utf-8");
}

function contentTypeMime(contentType: string): string {
	return contentType.split(";", 1)[0].trim().toLowerCase();
}

function isImageMime(mime: string): boolean {
	return mime.startsWith("image/") && mime !== "image/svg+xml";
}

function normalizeTimeout(timeout: number | undefined): number {
	if (timeout === undefined) return DEFAULT_TIMEOUT_SECONDS;
	return Math.min(Math.max(Math.floor(timeout), 1), MAX_TIMEOUT_SECONDS);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch content from a URL and return it as markdown (default), plain text, or html. " +
			"Image responses are returned as image attachments. Only public http(s) URLs; " +
			"internal and private addresses are blocked.",
		promptSnippet: "Use to read a specific web page, document, or file by URL.",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch. Must start with http:// or https://." }),
			format: Type.Optional(
				Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
					description: "Return format: markdown (default), text, or html.",
				}),
			),
			timeout: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 120, description: "Timeout in seconds (default 30, max 120)." }),
			),
		}),
		async execute(_callId, params, signal) {
			const format: FetchFormat = params.format ?? "markdown";
			const timeoutSeconds = normalizeTimeout(params.timeout);
			try {
				await validatePublicUrl(params.url);
				const { contentType, bytes } = await fetchResponse(params.url, format, timeoutSeconds, signal);
				const mime = contentTypeMime(contentType);

				if (isImageMime(mime)) {
					return {
						content: [
							{ type: "text", text: `Image fetched: ${params.url} (${contentType})` },
							{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mime },
						],
						details: { url: params.url, mime, bytes: bytes.byteLength },
					};
				}

				const text = decodeBody(contentType, bytes);
				let output: string;
				if (format === "markdown") {
					output = mime === "text/html" || mime === "application/xhtml+xml" ? convertHtmlToMarkdown(text) : text;
				} else if (format === "text") {
					output = mime === "text/html" || mime === "application/xhtml+xml" ? extractTextFromHtml(text) : text;
				} else {
					output = text;
				}
				return {
					content: [{ type: "text", text: output }],
					details: { url: params.url, contentType, format, bytes: bytes.byteLength },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					details: { error: message },
				};
			}
		},
	});
}
