"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SKILL_NAME_RE = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;
const MEMORY_DOCUMENTS = Object.freeze({ summary: "memory_summary.md", handbook: "MEMORY.md" });
const EXTENSION_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);

function sha256Revision(value) {
	return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8")).digest("hex");
}

function canonicalExistingAncestor(candidate) {
	let current = path.resolve(candidate);
	const suffix = [];
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) throw new Error(`No existing ancestor for path: ${candidate}`);
		suffix.unshift(path.basename(current));
		current = parent;
	}
	return path.join(fs.realpathSync.native(current), ...suffix);
}

function isPathContained(root, candidate) {
	try {
		const realRoot = fs.realpathSync.native(path.resolve(root));
		const resolved = canonicalExistingAncestor(candidate);
		const relative = path.relative(realRoot, resolved);
		return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
	} catch {
		return false;
	}
}

function resolveContainedPath(root, ...parts) {
	if (!fs.existsSync(root)) throw new Error(`Allowed root does not exist: ${root}`);
	for (const part of parts) {
		if (typeof part !== "string" || part.includes("\0") || path.isAbsolute(part)) throw new Error("Invalid relative path");
	}
	const candidate = path.resolve(root, ...parts);
	if (!isPathContained(root, candidate)) throw new Error("Path escapes allowed root");
	return candidate;
}

function assertExpectedRevision(current, expectedRevision) {
	if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
		throw Object.assign(new Error("A valid expected revision is required"), { code: "INVALID_REVISION" });
	}
	const actualRevision = sha256Revision(current);
	if (!crypto.timingSafeEqual(Buffer.from(actualRevision), Buffer.from(expectedRevision))) {
		throw Object.assign(new Error("Revision conflict"), { code: "REVISION_CONFLICT", expectedRevision, actualRevision });
	}
	return actualRevision;
}

function atomicWriteFile(filePath, content, options = {}) {
	const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
	const directory = path.dirname(filePath);
	fs.mkdirSync(directory, { recursive: true });
	const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
	let fd;
	try {
		fd = fs.openSync(temporary, "wx", options.mode ?? 0o600);
		fs.writeFileSync(fd, data);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		if (options.exclusive && fs.existsSync(filePath)) throw Object.assign(new Error("Resource already exists"), { code: "RESOURCE_EXISTS" });
		fs.renameSync(temporary, filePath);
		try {
			const directoryFd = fs.openSync(directory, "r");
			try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
		} catch { /* Some platforms/filesystems do not support directory fsync. */ }
	} catch (error) {
		if (fd !== undefined) fs.closeSync(fd);
		try { fs.unlinkSync(temporary); } catch {}
		throw error;
	}
	return { path: filePath, revision: sha256Revision(data), bytes: data.length };
}

function lockOwnerIsStale(lockPath, staleMs = 5 * 60_000) {
	try {
		const stat = fs.statSync(lockPath);
		const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
		if (!Number.isInteger(owner.pid) || owner.pid <= 0) return Date.now() - stat.mtimeMs > staleMs;
		try { process.kill(owner.pid, 0); return false; }
		catch (error) { return error?.code === "ESRCH"; }
	} catch {
		// A newly-created lock directory may not have its owner file yet. Treat
		// malformed locks as active until they are old enough to be unambiguously stale.
		try { return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs; } catch { return false; }
	}
}

function withFileLock(filePath, operation) {
	const lockPath = `${filePath}.pi-web.lock`;
	let nonce;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			nonce = crypto.randomBytes(8).toString("hex");
			fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce }), { mode: 0o600 });
			break;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			if (attempt === 0 && lockOwnerIsStale(lockPath)) { try { fs.rmSync(lockPath, { recursive: true }); } catch {} continue; }
			throw Object.assign(new Error("Resource is locked by another Pi Web process"), { code: "RESOURCE_LOCKED" });
		}
	}
	try { return operation(); }
	finally {
		try {
			const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
			if (owner.nonce === nonce) fs.rmSync(lockPath, { recursive: true });
		} catch { /* Never remove a lock whose ownership cannot be verified. */ }
	}
}

function createFileExclusive(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	return withFileLock(filePath, () => atomicWriteFile(filePath, content, { exclusive: true }));
}

function writeFileWithRevision(filePath, content, expectedRevision, options = {}) {
	return withFileLock(filePath, () => {
		const stat = fs.statSync(filePath);
		if (options.maxCurrentBytes !== undefined && stat.size > options.maxCurrentBytes) throw Object.assign(new Error("Resource is too large to edit"), { code: "RESOURCE_TOO_LARGE" });
		const current = fs.readFileSync(filePath);
		assertExpectedRevision(current, expectedRevision);
		return atomicWriteFile(filePath, content);
	});
}

function deleteFileWithRevision(filePath, expectedRevision) {
	return withFileLock(filePath, () => {
		const current = fs.readFileSync(filePath);
		assertExpectedRevision(current, expectedRevision);
		fs.unlinkSync(filePath);
		return { path: filePath, revision: sha256Revision(current), bytes: current.length };
	});
}

function normalizeSessionName(name) {
	const normalized = String(name ?? "").replace(/[\r\n]+/g, " ").trim();
	if (!normalized || normalized.length > 200) throw Object.assign(new Error("Session name must be between 1 and 200 characters"), { code: "INVALID_SESSION_NAME" });
	return normalized;
}

function renameSessionWithRevision(filePath, name, expectedRevision, rename, maxBytes = 16 * 1024 * 1024) {
	return withFileLock(filePath, () => {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size > maxBytes) throw Object.assign(new Error("Session is too large to rename"), { code: "RESOURCE_TOO_LARGE" });
		const current = fs.readFileSync(filePath);
		assertExpectedRevision(current, expectedRevision);
		const normalizedName = normalizeSessionName(name);
		rename(normalizedName);
		const updated = fs.readFileSync(filePath);
		return { name: normalizedName, revision: sha256Revision(updated), bytes: updated.length };
	});
}

function removeSessionWithRevision(filePath, expectedRevision, remove, maxBytes = 16 * 1024 * 1024) {
	return withFileLock(filePath, () => {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size > maxBytes) throw Object.assign(new Error("Session is too large to delete through Pi Web"), { code: "RESOURCE_TOO_LARGE" });
		const current = fs.readFileSync(filePath);
		const revision = assertExpectedRevision(current, expectedRevision);
		const removal = remove(filePath) || {};
		if (fs.existsSync(filePath)) throw new Error("Session removal did not remove the file");
		return { deleted: true, method: removal.method, revision, bytes: current.length };
	});
}

function readTextBounded(filePath, maxBytes = 10 * 1024 * 1024) {
	const size = fs.statSync(filePath).size;
	const length = Math.min(size, Math.max(0, maxBytes));
	const buffer = Buffer.alloc(length);
	const fd = fs.openSync(filePath, "r");
	try { if (length) fs.readSync(fd, buffer, 0, length, 0); } finally { fs.closeSync(fd); }
	return { text: buffer.toString("utf8"), bytes: length, truncated: size > length };
}

function readTailLinesBounded(filePath, lineCount = 50, maxBytes = 256 * 1024) {
	try {
		const size = fs.statSync(filePath).size;
		const length = Math.min(size, Math.max(0, maxBytes));
		const buffer = Buffer.alloc(length);
		const fd = fs.openSync(filePath, "r");
		try { if (length) fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
		let lines = buffer.toString("utf8").split(/\r?\n/);
		if (size > length) lines = lines.slice(1);
		return lines.filter(Boolean).slice(-Math.max(1, lineCount));
	} catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

function parseScalar(source) {
	const value = source.trim();
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null" || value === "~") return null;
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		if (value[0] === '"') {
			try { return JSON.parse(value); } catch { return value.slice(1, -1); }
		}
		return value.slice(1, -1).replace(/''/g, "'");
	}
	return value;
}

function parseSkillFrontmatter(text) {
	const source = String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	if (!source.startsWith("---\n")) return { attributes: {}, body: source, errors: ["SKILL.md must start with YAML frontmatter"] };
	const end = source.indexOf("\n---\n", 4);
	if (end < 0) return { attributes: {}, body: "", errors: ["SKILL.md frontmatter is not closed"] };
	const attributes = {};
	const errors = [];
	let mappingKey;
	for (const rawLine of source.slice(4, end).split("\n")) {
		if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
		const nested = rawLine.match(/^\s{2,}([^:#][^:]*):\s*(.*)$/);
		if (nested && mappingKey) {
			attributes[mappingKey][nested[1].trim()] = parseScalar(nested[2]);
			continue;
		}
		const match = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) { errors.push(`Unsupported frontmatter line: ${rawLine.trim()}`); mappingKey = undefined; continue; }
		const [, key, rawValue] = match;
		if (!rawValue) { attributes[key] = {}; mappingKey = key; }
		else { attributes[key] = parseScalar(rawValue); mappingKey = undefined; }
	}
	const body = source.slice(end + 5).replace(/^\n/, "");
	return { attributes, body, errors };
}

function validateSkillDocument(text) {
	const parsed = parseSkillFrontmatter(text);
	const errors = [...parsed.errors];
	const warnings = [];
	const { name, description, metadata } = parsed.attributes;
	if (typeof name !== "string" || !name) errors.push("Skill name is required");
	else if (!SKILL_NAME_RE.test(name)) errors.push("Skill name must be 1-64 lowercase letters, numbers, or hyphens without edge or consecutive hyphens");
	if (typeof description !== "string" || !description.trim()) errors.push("Skill description is required");
	else if (description.length > 1024) errors.push("Skill description must not exceed 1024 characters");
	if (parsed.attributes.compatibility !== undefined && (typeof parsed.attributes.compatibility !== "string" || parsed.attributes.compatibility.length > 500)) errors.push("Skill compatibility must be a string of at most 500 characters");
	if (metadata !== undefined && (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))) errors.push("Skill metadata must be a key-value mapping");
	for (const key of ["license", "allowed-tools"]) if (parsed.attributes[key] !== undefined && typeof parsed.attributes[key] !== "string") errors.push(`${key} must be a string`);
	if (parsed.attributes["disable-model-invocation"] !== undefined && typeof parsed.attributes["disable-model-invocation"] !== "boolean") errors.push("disable-model-invocation must be a boolean");
	if (!parsed.body.trim()) warnings.push("Skill body is empty");
	return { valid: errors.length === 0, errors, warnings, name, description, metadata: metadata ?? {}, body: parsed.body, attributes: parsed.attributes };
}

function quoteYaml(value) {
	return JSON.stringify(String(value));
}

function serializeSkillDocument(input) {
	const lines = ["---", `name: ${quoteYaml(input.name)}`, `description: ${quoteYaml(input.description)}`];
	for (const key of ["license", "compatibility", "allowed-tools"]) if (input[key] !== undefined) lines.push(`${key}: ${quoteYaml(input[key])}`);
	if (input.metadata !== undefined) {
		lines.push("metadata:");
		for (const key of Object.keys(input.metadata).sort()) lines.push(`  ${key}: ${quoteYaml(input.metadata[key])}`);
	}
	if (input["disable-model-invocation"] !== undefined) lines.push(`disable-model-invocation: ${input["disable-model-invocation"] ? "true" : "false"}`);
	lines.push("---", "", String(input.body ?? "").replace(/^\s*\n/, ""));
	const document = `${lines.join("\n").replace(/\n+$/, "")}\n`;
	const validation = validateSkillDocument(document);
	if (!validation.valid) throw Object.assign(new Error(validation.errors.join("; ")), { code: "INVALID_SKILL", diagnostics: validation });
	return document;
}

function parseJsonFile(filePath) {
	try {
		const text = fs.readFileSync(filePath, "utf8");
		const value = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings root must be an object");
		return { path: filePath, exists: true, value, revision: sha256Revision(text), diagnostics: [] };
	} catch (error) {
		if (error && error.code === "ENOENT") return { path: filePath, exists: false, value: {}, diagnostics: [] };
		return { path: filePath, exists: fs.existsSync(filePath), value: {}, diagnostics: [error instanceof Error ? error.message : String(error)] };
	}
}

function displayNameFromSource(source) {
	const value = String(source ?? "").trim().replace(/[\\/]+$/, "");
	if (!value) return "Unknown";
	if (value.startsWith("npm:")) return value.slice(4).replace(/@[^/@]+$/, "") || value.slice(4);
	const withoutQuery = value.split(/[?#]/, 1)[0].replace(/\.git$/, "");
	return withoutQuery.split(/[\\/]/).filter(Boolean).pop() || value;
}

function displayNameFromExtension(relativePath, root) {
	const normalized = String(relativePath ?? "").replaceAll("\\", "/");
	const parts = normalized.split("/").filter(Boolean);
	const file = parts.pop() || "";
	if (/^index\.(?:[cm]?[jt]s)$/i.test(file)) return parts.pop() || path.basename(root || "") || "index";
	return file.replace(/\.(?:[cm]?[jt]s)$/i, "") || path.basename(root || "") || "Extension";
}

function normalizeSettingItems(value, key, scope, settingsPath) {
	if (value === undefined) return { items: [], diagnostics: [] };
	if (!Array.isArray(value)) return { items: [], diagnostics: [`${key} in ${settingsPath} must be an array`] };
	const diagnostics = [];
	const items = [];
	for (let index = 0; index < value.length; index++) {
		const entry = value[index];
		if (typeof entry === "string" && entry.trim()) items.push({ source: entry, displayName: key === "extensions" ? displayNameFromExtension(entry) : displayNameFromSource(entry), scope, settingsPath, index });
		else if (key === "packages" && entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.source === "string") {
			const item = { source: entry.source, displayName: displayNameFromSource(entry.source), scope, settingsPath, index };
			for (const filter of ["extensions", "skills", "prompts", "themes"]) if (Array.isArray(entry[filter]) && entry[filter].every((value) => typeof value === "string")) item[filter] = [...entry[filter]];
			if (typeof entry.autoload === "boolean") item.autoload = entry.autoload;
			items.push(item);
		}
		else diagnostics.push(`Invalid ${key}[${index}] in ${settingsPath}`);
	}
	return { items, diagnostics };
}

function catalogSettings(globalSettingsPath, projectSettingsPath) {
	const sources = [["global", globalSettingsPath], ["project", projectSettingsPath]].filter(([, file]) => file);
	const packages = [], extensionPaths = [], diagnostics = [], settings = [];
	for (const [scope, file] of sources) {
		const parsed = parseJsonFile(file);
		settings.push({ scope, ...parsed });
		diagnostics.push(...parsed.diagnostics.map((message) => ({ scope, path: file, message })));
		for (const [key, target] of [["packages", packages], ["extensions", extensionPaths]]) {
			const normalized = normalizeSettingItems(parsed.value[key], key, scope, file);
			target.push(...normalized.items);
			diagnostics.push(...normalized.diagnostics.map((message) => ({ scope, path: file, message })));
		}
	}
	return { settings, packages, extensionPaths, diagnostics };
}

function walkFiles(root, accept, output = []) {
	if (!fs.existsSync(root)) return output;
	for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const fullPath = path.join(root, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) walkFiles(fullPath, accept, output);
		else if (entry.isFile() && accept(fullPath)) output.push(fullPath);
	}
	return output;
}

function catalogExtensions(roots) {
	const entries = [], diagnostics = [];
	for (const rootInfo of roots) {
		const root = typeof rootInfo === "string" ? rootInfo : rootInfo.path;
		const scope = typeof rootInfo === "string" ? "unknown" : rootInfo.scope;
		try {
			for (const file of walkFiles(root, (candidate) => EXTENSION_EXTENSIONS.has(path.extname(candidate)))) {
				const relativePath = path.relative(root, file);
				entries.push({ id: sha256Revision(`${scope}\0${file}`), displayName: displayNameFromExtension(relativePath, root), path: file, relativePath, scope });
			}
		} catch (error) { diagnostics.push({ path: root, scope, message: error instanceof Error ? error.message : String(error) }); }
	}
	return { entries, diagnostics };
}

function catalogEffectiveSkills(commands, writableRoots = []) {
	const skills = [], diagnostics = [];
	for (const command of Array.isArray(commands) ? commands : []) {
		if (!command || command.source !== "skill") continue;
		const sourceInfo = command.sourceInfo && typeof command.sourceInfo === "object" ? command.sourceInfo : {};
		const file = typeof sourceInfo.path === "string" ? path.resolve(sourceInfo.path) : "";
		if (!file || !fs.existsSync(file)) {
			diagnostics.push({ scope: sourceInfo.scope, message: `Effective skill path is unavailable: ${file || "unknown"}` });
			continue;
		}
		try {
			const document = readTextBounded(file, 1024 * 1024);
			const validation = validateSkillDocument(document.text);
			const root = writableRoots.find((candidate) => candidate.mutable && candidate.scope === sourceInfo.scope && isPathContained(candidate.path, file));
			const name = String(command.name ?? validation.name ?? path.basename(path.dirname(file))).replace(/^skill:/, "");
			const item = {
				id: sha256Revision(`effective-skill\0${name}\0${file}`), name,
				description: String(command.description ?? validation.description ?? ""), path: file,
				scope: String(sourceInfo.scope ?? "unknown"), origin: String(sourceInfo.origin ?? "unknown"), source: String(sourceInfo.source ?? "unknown"),
				mutable: Boolean(root) && !document.truncated, truncated: document.truncated,
				revision: document.truncated ? undefined : sha256Revision(document.text),
				disableModelInvocation: Boolean(validation.attributes?.["disable-model-invocation"]),
				diagnostics: [...validation.errors, ...validation.warnings],
			};
			skills.push(item);
			for (const message of validation.errors) diagnostics.push({ path: file, scope: item.scope, message });
		} catch (error) {
			diagnostics.push({ path: file, scope: sourceInfo.scope, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { skills, diagnostics };
}

function catalogSkills(roots) {
	const skills = [], diagnostics = [];
	for (const rootInfo of roots) {
		const root = typeof rootInfo === "string" ? rootInfo : rootInfo.path;
		const scope = typeof rootInfo === "string" ? "unknown" : rootInfo.scope;
		const mutable = typeof rootInfo === "string" ? false : Boolean(rootInfo.mutable);
		try {
			for (const file of walkFiles(root, (candidate) => path.basename(candidate) === "SKILL.md")) {
				const document = readTextBounded(file, 1024 * 1024);
				const validation = validateSkillDocument(document.text);
				if (document.truncated) validation.errors.push("SKILL.md exceeds the 1 MiB management limit");
				const item = { id: sha256Revision(`${scope}\0${file}`), path: file, relativePath: path.relative(root, file), scope, mutable: mutable && !document.truncated, truncated: document.truncated, revision: document.truncated ? undefined : sha256Revision(document.text), name: validation.name, description: validation.description, diagnostics: [...validation.errors, ...validation.warnings] };
				skills.push(item);
				for (const message of validation.errors) diagnostics.push({ path: file, scope, message });
			}
		} catch (error) { diagnostics.push({ path: root, scope, message: error instanceof Error ? error.message : String(error) }); }
	}
	return { skills, diagnostics };
}

function validateMemoryDocument(document, content) {
	const text = String(content);
	const errors = [];
	if (!Object.hasOwn(MEMORY_DOCUMENTS, document)) errors.push("Memory document is not editable");
	if (text.includes("\0")) errors.push("Memory document contains NUL bytes");
	if (document === "summary" && text.split(/\r?\n/, 1)[0] !== "v1") errors.push("memory_summary.md first line must be exactly v1");
	return { valid: errors.length === 0, errors, fileName: MEMORY_DOCUMENTS[document] };
}

function parseSessionJsonl(text, options = {}) {
	const maxEntries = Math.max(0, options.maxEntries ?? 1000);
	const lines = String(text).split(/\r?\n/);
	let header = null;
	const entries = [], diagnostics = [];
	const counts = {};
	let firstTimestamp, lastTimestamp;
	for (let index = 0; index < lines.length; index++) {
		if (!lines[index].trim()) continue;
		let value;
		try { value = JSON.parse(lines[index]); }
		catch (error) { diagnostics.push({ line: index + 1, message: error instanceof Error ? error.message : String(error) }); continue; }
		if (!value || typeof value !== "object" || Array.isArray(value)) { diagnostics.push({ line: index + 1, message: "JSONL entry must be an object" }); continue; }
		if (header === null && (value.type === "session" || value.type === "session_meta")) header = value;
		else if (entries.length < maxEntries) entries.push(value);
		counts[value.type ?? "unknown"] = (counts[value.type ?? "unknown"] ?? 0) + 1;
		const timestamp = Date.parse(value.timestamp ?? value.payload?.timestamp ?? "");
		if (Number.isFinite(timestamp)) { firstTimestamp = firstTimestamp === undefined ? timestamp : Math.min(firstTimestamp, timestamp); lastTimestamp = lastTimestamp === undefined ? timestamp : Math.max(lastTimestamp, timestamp); }
	}
	const sessionId = header?.id ?? header?.sessionId ?? header?.payload?.id;
	return { header, entries, diagnostics, summary: { sessionId, cwd: header?.cwd ?? header?.payload?.cwd, totalEntries: Object.values(counts).reduce((sum, count) => sum + count, 0), returnedEntries: entries.length, truncated: Object.values(counts).reduce((sum, count) => sum + count, 0) - (header ? 1 : 0) > entries.length, counts, firstTimestamp, lastTimestamp } };
}

function sessionTime(session) {
	const value = session?.modified ?? session?.updatedAt ?? session?.created ?? session?.createdAt ?? 0;
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function summarizeSessions(sessions, query = "") {
	const needle = String(query).trim().toLowerCase();
	return sessions.map((session) => ({ ...session, id: session.id ?? session.sessionId ?? path.basename(session.file ?? "", path.extname(session.file ?? "")) }))
		.filter((session) => !needle || [session.id, session.name, session.cwd, session.file, session.firstMessage, session.allMessagesText].some((value) => String(value ?? "").toLowerCase().includes(needle)))
		.sort((a, b) => sessionTime(b) - sessionTime(a));
}

function sessionPathParts(cwd) {
	const value = String(cwd ?? "").trim().replaceAll("\\", "/");
	if (!value) return ["Unknown project"];
	if (/^[A-Za-z]:\//.test(value)) return [value.slice(0, 2), ...value.slice(3).split("/").filter(Boolean)];
	if (value.startsWith("//")) return ["//", ...value.slice(2).split("/").filter(Boolean)];
	if (value.startsWith("/")) return ["/", ...value.slice(1).split("/").filter(Boolean)];
	return value.split("/").filter(Boolean);
}

function buildSessionTree(sessions) {
	const roots = new Map();
	for (const session of sessions) {
		let siblings = roots;
		let node;
		let nodePath = "";
		for (const part of sessionPathParts(session.cwd)) {
			nodePath = nodePath ? `${nodePath}/${part}` : part;
			node = siblings.get(part);
			if (!node) {
				node = { id: sha256Revision(`session-directory\0${nodePath}`), name: part, children: new Map(), sessions: [], sessionCount: 0, modified: undefined };
				siblings.set(part, node);
			}
			siblings = node.children;
		}
		node.sessions.push(session);
	}
	function finish(nodes) {
		return [...nodes.values()].map((node) => {
			const children = finish(node.children);
			node.sessions.sort((a, b) => sessionTime(b) - sessionTime(a));
			const latestSession = node.sessions[0];
			const latestChild = children.reduce((latest, child) => sessionTime(child) > sessionTime(latest) ? child : latest, undefined);
			const latest = sessionTime(latestSession) >= sessionTime(latestChild) ? latestSession : latestChild;
			return { id: node.id, name: node.name, children, sessions: node.sessions, sessionCount: node.sessions.length + children.reduce((sum, child) => sum + child.sessionCount, 0), modified: latest?.modified ?? latest?.updatedAt ?? latest?.created ?? latest?.createdAt };
		}).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
	}
	return finish(roots);
}

module.exports = {
	SKILL_NAME_RE, MEMORY_DOCUMENTS, sha256Revision, isPathContained, resolveContainedPath,
	assertExpectedRevision, atomicWriteFile, createFileExclusive, writeFileWithRevision, deleteFileWithRevision,
	normalizeSessionName, renameSessionWithRevision, removeSessionWithRevision, readTextBounded, readTailLinesBounded,
	parseSkillFrontmatter, validateSkillDocument, serializeSkillDocument,
	parseJsonFile, catalogSettings, catalogExtensions, catalogSkills, catalogEffectiveSkills,
	validateMemoryDocument, parseSessionJsonl, summarizeSessions, buildSessionTree,
};
