/**
 * pi-env: load a pi-specific .env file into process.env — without polluting
 * your global shell environment.
 *
 * Loading order (per key, first definition wins):
 *   1. Existing process.env (real environment always takes precedence)
 *   2. Project-local  <cwd>/.pi/.env       (per-project overrides)
 *   3. Global         ~/.pi/agent/.env     (shared secrets/config)
 *
 * The file is parsed at module load time — before later extensions in the
 * packages list are imported — so extensions that read env vars at module
 * scope (e.g. pi-openviking-memory's OPENVIKING_SERVER_URL) pick the values up.
 * Keep this package FIRST in settings.json's packages list.
 *
 * Format: KEY=VALUE per line. Supports `export KEY=VALUE`, `#` comments,
 * blank lines, and single/double-quoted values.
 *
 * Commands:
 *   /env          list loaded variables (values masked)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface LoadedVar {
	key: string;
	from: "global" | "project";
}

const loaded: LoadedVar[] = [];

function parseEnvFile(raw: string): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	for (const line of raw.split("\n")) {
		let s = line.trim();
		if (!s || s.startsWith("#")) continue;
		if (s.startsWith("export ")) s = s.slice(7).trim();
		const eq = s.indexOf("=");
		if (eq <= 0) continue;
		const key = s.slice(0, eq).trim();
		let value = s.slice(eq + 1).trim();
		// strip trailing inline comment on unquoted values
		if (!value.startsWith('"') && !value.startsWith("'")) {
			const hash = value.indexOf(" #");
			if (hash >= 0) value = value.slice(0, hash).trim();
		}
		// strip surrounding quotes
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}
		if (key) pairs.push([key, value]);
	}
	return pairs;
}

function loadEnvFile(file: string, from: "global" | "project"): void {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return; // missing file is fine
	}
	for (const [key, value] of parseEnvFile(raw)) {
		if (process.env[key] !== undefined) continue; // real env wins
		process.env[key] = value;
		loaded.push({ key, from });
	}
}

// Load at module import time — before later packages' modules are evaluated.
loadEnvFile(path.join(os.homedir(), ".pi", "agent", ".env"), "global");
loadEnvFile(path.join(process.cwd(), ".pi", ".env"), "project");

export default function (pi: ExtensionAPI) {
	pi.registerCommand("env", {
		description: "pi-env: list variables loaded from .env files (values masked)",
		handler: async (_args, ctx) => {
			if (loaded.length === 0) {
				ctx.ui.notify("pi-env: no .env variables loaded (looked at ~/.pi/agent/.env and .pi/.env)", "info");
				return;
			}
			const lines = loaded
				.map((v) => {
					const raw = process.env[v.key] ?? "";
					const masked = raw.length <= 6 ? "***" : `${raw.slice(0, 3)}***${raw.slice(-3)}`;
					return `${v.key}=${masked}  (${v.from})`;
				})
				.sort();
			ctx.ui.notify(`pi-env loaded ${loaded.length} variables:\n${lines.join("\n")}`, "info");
		},
	});
}
