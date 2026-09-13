import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	atomicWriteFile,
	buildSessionTree,
	catalogEffectiveSkills,
	catalogExtensions,
	catalogSettings,
	catalogSkills,
	isPathContained,
	normalizeSessionChatHistory,
	parseSessionJsonl,
	parseSkillFrontmatter,
	readTextBounded,
	readTailLinesBounded,
	removeSessionWithRevision,
	selectActiveSessionBranch,
	renameSessionWithRevision,
	resolveContainedPath,
	serializeSkillDocument,
	sha256Revision,
	summarizeSessions,
	validateMemoryDocument,
	validateSkillDocument,
	writeFileWithRevision,
} from "../packages/pi-web/lib/pi-web-core.cjs";

function withTempDir(prefix, run) {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	try { return run(directory); }
	finally { rmSync(directory, { recursive: true, force: true }); }
}

test("path containment rejects traversal, siblings, and symlink escapes", () => withTempDir("pi-web-path-", (directory) => {
	const root = join(directory, "allowed");
	const outside = join(directory, "outside");
	mkdirSync(root); mkdirSync(outside);
	writeFileSync(join(outside, "secret"), "no");
	symlinkSync(outside, join(root, "link"));
	assert.equal(isPathContained(root, root), true);
	assert.equal(isPathContained(root, join(root, "new", "SKILL.md")), true);
	assert.equal(isPathContained(root, join(directory, "allowed-sibling")), false);
	assert.equal(isPathContained(root, join(root, "link", "secret")), false);
	assert.equal(resolveContainedPath(root, "safe", "SKILL.md"), join(root, "safe", "SKILL.md"));
	assert.throws(() => resolveContainedPath(root, "..", "outside", "secret"), /escapes/);
	assert.throws(() => resolveContainedPath(root, join(outside, "secret")), /Invalid relative path/);
}));

test("sha256 revisions are deterministic and writes are atomic CAS", () => withTempDir("pi-web-write-", (directory) => {
	const file = join(directory, "doc.md");
	const first = atomicWriteFile(file, "one\n");
	assert.equal(first.revision, sha256Revision("one\n"));
	assert.equal(readFileSync(file, "utf8"), "one\n");
	const second = writeFileWithRevision(file, "two\n", first.revision);
	assert.equal(second.revision, sha256Revision("two\n"));
	assert.throws(() => writeFileWithRevision(file, "lost update\n", first.revision), (error) => error.code === "REVISION_CONFLICT" && error.actualRevision === second.revision);
	mkdirSync(`${file}.pi-web.lock`);
	writeFileSync(join(`${file}.pi-web.lock`, "owner.json"), JSON.stringify({ pid: process.pid }));
	assert.throws(() => writeFileWithRevision(file, "locked\n", second.revision), (error) => error.code === "RESOURCE_LOCKED");
	writeFileSync(join(`${file}.pi-web.lock`, "owner.json"), JSON.stringify({ pid: 99999999 }));
	const recovered = writeFileWithRevision(file, "recovered\n", second.revision);
	assert.equal(recovered.revision, sha256Revision("recovered\n"));
	assert.deepEqual(readdirSync(directory).filter((entry) => entry.includes(".tmp")), []);
}));

test("bounded readers cap bytes and return only the requested tail lines", () => withTempDir("pi-web-bounds-", (directory) => {
	const file = join(directory, "large.log");
	writeFileSync(file, `${"x".repeat(100)}\nlast-one\nlast-two\n`);
	const head = readTextBounded(file, 32);
	assert.equal(Buffer.byteLength(head.text), 32);
	assert.equal(head.truncated, true);
	assert.deepEqual(readTailLinesBounded(file, 2, 32), ["last-one", "last-two"]);
}));

test("SKILL frontmatter parses metadata and validates Agent Skills limits", () => {
	const text = [
		"---", "name: web-tools", "description: \"Safe web tools\"", "metadata:", "  owner: platform", "  tier: 1", "compatibility: node 20", "disable-model-invocation: true", "---", "", "# Web tools", "",
	].join("\n");
	const parsed = parseSkillFrontmatter(text);
	assert.deepEqual(parsed.attributes.metadata, { owner: "platform", tier: "1" });
	assert.equal(parsed.attributes["disable-model-invocation"], true);
	assert.equal(validateSkillDocument(text).valid, true);
	for (const [name, description] of [["Bad_Name", "ok"], ["bad--name", "ok"], ["ok", ""]]) {
		const result = validateSkillDocument(`---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
		assert.equal(result.valid, false, name);
	}
	assert.equal(validateSkillDocument(`---\nname: ok\ndescription: ${"x".repeat(1025)}\n---\nbody\n`).valid, false);
});

test("SKILL serialization preserves supported metadata and produces a valid document", () => {
	const document = serializeSkillDocument({ name: "release-check", description: "Checks releases: safely", metadata: { owner: "devex", version: "1" }, "allowed-tools": "read bash", body: "# Release\nRun checks." });
	const validation = validateSkillDocument(document);
	assert.equal(validation.valid, true);
	assert.deepEqual(validation.metadata, { owner: "devex", version: "1" });
	assert.match(validation.body, /^# Release/);
	assert.throws(() => serializeSkillDocument({ name: "NO", description: "bad" }), (error) => error.code === "INVALID_SKILL");
});

test("settings and static extension catalogs retain scope without loading code", () => withTempDir("pi-web-catalog-", (directory) => {
	const globalSettings = join(directory, "global.json");
	const projectSettings = join(directory, "project.json");
	writeFileSync(globalSettings, JSON.stringify({ packages: ["npm:one", { source: "git:example/repo", extensions: [] }], extensions: ["./global.ts"] }));
	writeFileSync(projectSettings, JSON.stringify({ packages: ["./local"], extensions: [42] }));
	const settings = catalogSettings(globalSettings, projectSettings);
	assert.deepEqual(settings.packages.map(({ source, scope }) => [source, scope]), [["npm:one", "global"], ["git:example/repo", "global"], ["./local", "project"]]);
	assert.deepEqual(settings.packages.map((item) => item.displayName), ["one", "repo", "local"]);
	assert.deepEqual(settings.extensionPaths.map(({ source, scope }) => [source, scope]), [["./global.ts", "global"]]);
	assert.equal(settings.extensionPaths[0].displayName, "global");
	assert.match(settings.diagnostics[0].message, /Invalid extensions\[0\]/);

	const extensions = join(directory, "extensions");
	mkdirSync(join(extensions, "nested"), { recursive: true });
	writeFileSync(join(extensions, "danger.ts"), "throw new Error('must not execute')");
	writeFileSync(join(extensions, "nested", "index.cjs"), "process.exit(9)");
	writeFileSync(join(extensions, "README.md"), "ignore");
	const catalog = catalogExtensions([{ path: extensions, scope: "project" }]);
	assert.deepEqual(catalog.entries.map((entry) => entry.relativePath), ["danger.ts", join("nested", "index.cjs")]);
	assert.deepEqual(catalog.entries.map((entry) => entry.displayName), ["danger", "nested"]);
	assert.ok(catalog.entries.every((entry) => entry.scope === "project"));
}));

test("effective skill catalog maps only runtime skills with field allowlisting and independent mutability", () => withTempDir("pi-web-effective-skills-", (directory) => {
	const writableRoot = join(directory, "agent", "skills");
	const writableFile = join(writableRoot, "editable", "SKILL.md");
	const packageFile = join(directory, "package", "skills", "packaged", "SKILL.md");
	mkdirSync(join(writableRoot, "editable"), { recursive: true });
	mkdirSync(join(directory, "package", "skills", "packaged"), { recursive: true });
	writeFileSync(writableFile, "---\nname: editable\ndescription: Editable\n---\n# Editable\n");
	writeFileSync(packageFile, "---\nname: packaged\ndescription: Packaged\n---\n# Packaged\n");
	const result = catalogEffectiveSkills([
		{ name: "skill:editable", description: "Runtime editable", source: "skill", sourceInfo: { path: writableFile, source: "auto", scope: "user", origin: "top-level" }, secret: "NOPE" },
		{ name: "skill:packaged", description: "Runtime packaged", source: "skill", sourceInfo: { path: packageFile, source: "npm:pkg", scope: "user", origin: "package", baseDir: directory }, secret: "NOPE" },
		{ name: "not-a-skill", source: "extension", sourceInfo: { path: "/tmp/nope" } },
	], [{ path: writableRoot, scope: "user", mutable: true }]);
	assert.deepEqual(result.skills.map((skill) => skill.name), ["editable", "packaged"]);
	assert.equal(result.skills[0].mutable, true);
	assert.equal(result.skills[1].mutable, false);
	assert.equal(result.skills[1].source, "npm:pkg");
	assert.equal(result.skills[1].origin, "package");
	assert.doesNotMatch(JSON.stringify(result), /NOPE|secret/);
}));

test("skill catalog reports validation diagnostics and mutability", () => withTempDir("pi-web-skills-", (directory) => {
	const root = join(directory, "skills");
	mkdirSync(join(root, "good"), { recursive: true });
	mkdirSync(join(root, "bad"), { recursive: true });
	writeFileSync(join(root, "good", "SKILL.md"), "---\nname: good\ndescription: Useful skill\n---\n# Good\n");
	writeFileSync(join(root, "bad", "SKILL.md"), "# missing metadata\n");
	const catalog = catalogSkills([{ path: root, scope: "user", mutable: true }]);
	assert.equal(catalog.skills.length, 2);
	assert.equal(catalog.skills.find((skill) => skill.name === "good").mutable, true);
	assert.ok(catalog.skills.find((skill) => skill.relativePath.startsWith("bad")).diagnostics.length > 0);
	assert.ok(catalog.diagnostics.length > 0);
}));

test("memory validation restricts editable documents and enforces summary v1", () => {
	assert.deepEqual(validateMemoryDocument("summary", "v1\n\n# Summary\n"), { valid: true, errors: [], fileName: "memory_summary.md" });
	assert.equal(validateMemoryDocument("summary", "# Summary\n").valid, false);
	assert.equal(validateMemoryDocument("handbook", "# Memory\n").valid, true);
	assert.equal(validateMemoryDocument("rollout", "anything").valid, false);
	assert.equal(validateMemoryDocument("handbook", "bad\0data").valid, false);
});

test("session JSONL parsing returns header, bounded entries, diagnostics, and summary", () => {
	const jsonl = [
		JSON.stringify({ type: "session_meta", payload: { id: "session-1", cwd: "/repo", timestamp: "2026-01-01T00:00:00Z" } }),
		JSON.stringify({ type: "turn_context", timestamp: "2026-01-01T00:01:00Z" }),
		"not-json",
		JSON.stringify({ type: "response_item", timestamp: "2026-01-01T00:02:00Z", payload: { role: "assistant" } }),
		JSON.stringify({ type: "event_msg", timestamp: "2026-01-01T00:03:00Z" }),
	].join("\n");
	const parsed = parseSessionJsonl(jsonl, { maxEntries: 2 });
	assert.equal(parsed.summary.sessionId, "session-1");
	assert.equal(parsed.summary.cwd, "/repo");
	assert.equal(parsed.summary.totalEntries, 4);
	assert.equal(parsed.summary.returnedEntries, 2);
	assert.equal(parsed.summary.truncated, true);
	assert.deepEqual(parsed.summary.counts, { session_meta: 1, turn_context: 1, response_item: 1, event_msg: 1 });
	assert.equal(parsed.diagnostics[0].line, 3);
	assert.equal(parsed.entries.length, 2);
	assert.ok(parsed.summary.lastTimestamp > parsed.summary.firstTimestamp);
});

test("session active branch follows the last leaf and excludes abandoned siblings", () => {
	const records = [
		{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "start" } },
		{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "answer" } },
		{ type: "message", id: "abandoned", parentId: "a1", message: { role: "user", content: "abandoned branch" } },
		{ type: "compaction", id: "compact", parentId: "a1", summary: "context only", firstKeptEntryId: "u1" },
		{ type: "message", id: "u2", parentId: "compact", message: { role: "user", content: "active branch" } },
		{ type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: "latest" } },
	];
	const selected = selectActiveSessionBranch(records);
	assert.deepEqual(selected.map((record) => record.id), ["u1", "a1", "compact", "u2", "a2"]);
	assert.deepEqual(normalizeSessionChatHistory(selected).entries.map((entry) => entry.id), ["u1", "a1", "u2", "a2"]);
});

test("session active branch preserves legacy records without parentId as linear history", () => {
	const records = [
		{ type: "message", id: "old", message: { role: "user", content: "old" } },
		{ type: "message", id: "new", message: { role: "assistant", content: "new" } },
	];
	assert.equal(selectActiveSessionBranch(records), records);
});

test("session chat history preserves raw displayable content within structural bounds", () => {
	const records = [
		{ type: "message", id: "u1", parentId: "secret-parent", timestamp: "2026-01-01T00:00:00Z", path: "/private/session.jsonl", message: { role: "user", content: [{ type: "text", text: "Hello" }, { type: "image", data: "base64-secret", mimeType: "image/png" }], credentials: "NOPE" } },
		{ type: "message", id: "a1", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [
			{ type: "thinking", thinking: "Inspect cwd:/etc/shadow, comma,/var/private, `/opt/hidden`, file:///Users/alice/private, \\\\server\\share\\secret.txt, AKIAIOSFODNN7EXAMPLE and -----BEGIN PGP MESSAGE-----\nPGP_SECRET Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature", thinkingSignature: "SIGNED_SECRET", details: { token: "NOPE" } },
			{ type: "thinking", thinking: "REDACTED_MUST_NOT_LEAK", redacted: true },
			{ type: "text", text: "I will check." },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "cat /private/key", nested: { query: "needle", token: "NOPE" }, credentials: "NOPE" }, path: "/private/key" },
		], provider: "secret-provider", credentials: "NOPE" } },
		{ type: "message", id: "t1", timestamp: "2026-01-01T00:00:02Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "command completed" }], isError: false, details: { path: "/private/key", credentials: "NOPE" } } },
		{ type: "message", id: "c1", timestamp: "2026-01-01T00:00:03Z", message: { role: "custom", customType: "status", display: true, content: "Index refreshed", details: { path: "/private/index" } } },
		{ type: "message", id: "hidden", message: { role: "custom", customType: "internal", display: false, content: "hidden custom message" } },
		{ type: "message", id: "system", message: { role: "system", content: "system prompt" } },
		{ type: "custom_message", id: "cm1", timestamp: "2026-01-01T00:00:04Z", customType: "notice", display: true, content: [{ type: "text", text: "Visible notice" }], details: { credentials: "NOPE" } },
	];
	const history = normalizeSessionChatHistory(records);
	assert.deepEqual(history.entries, [
		{ id: "u1", role: "user", timestamp: "2026-01-01T00:00:00Z", content: [{ type: "text", text: "Hello" }] },
		{ id: "a1", role: "assistant", timestamp: "2026-01-01T00:00:01Z", content: [
			{ type: "thinking", text: "Inspect cwd:/etc/shadow, comma,/var/private, `/opt/hidden`, file:///Users/alice/private, \\\\server\\share\\secret.txt, AKIAIOSFODNN7EXAMPLE and -----BEGIN PGP MESSAGE-----\nPGP_SECRET Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature" },
			{ type: "thinking", text: "REDACTED_MUST_NOT_LEAK" },
			{ type: "text", text: "I will check." },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "cat /private/key", nested: { query: "needle", token: "NOPE" }, credentials: "NOPE" } },
		] },
		{ id: "t1", role: "toolResult", timestamp: "2026-01-01T00:00:02Z", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: "command completed" }] },
		{ id: "c1", role: "custom", timestamp: "2026-01-01T00:00:03Z", customType: "status", content: [{ type: "text", text: "Index refreshed" }] },
		{ id: "cm1", role: "custom", timestamp: "2026-01-01T00:00:04Z", customType: "notice", content: [{ type: "text", text: "Visible notice" }] },
	]);
	assert.deepEqual(history.metadata, { sourceEntries: 7, displayableEntries: 5, returnedEntries: 5, omittedEntries: 0, truncated: false, contentTruncated: false });
	const serialized = JSON.stringify(history);
	for (const visible of ["/etc/shadow", "/var/private", "/opt/hidden", "/Users/alice/private", "AKIAIOSFODNN7EXAMPLE", "PGP_SECRET", "eyJhbGci", "REDACTED_MUST_NOT_LEAK", "/private/key", "credentials", "NOPE"]) assert.match(serialized, new RegExp(visible.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(serialized, /private\/session|details|secret-provider|base64-secret|hidden custom|system prompt|SIGNED_SECRET|thinkingSignature/);
});

test("session chat history preserves interleaved assistant block order", () => {
	const history = normalizeSessionChatHistory([{ type: "message", id: "a1", message: { role: "assistant", content: [
		{ type: "thinking", thinking: "first thought" },
		{ type: "text", text: "first answer" },
		{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
		{ type: "thinking", thinking: "second thought" },
		{ type: "text", text: "second answer" },
	] } }]);
	assert.deepEqual(history.entries[0].content.map((block) => block.type), ["thinking", "text", "toolCall", "thinking", "text"]);
});

test("session chat history preserves secrets and absolute paths in visible text", () => {
	const history = normalizeSessionChatHistory([
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "token=sk-abcdefghijklmnop Authorization: Basic dXNlcjpwYXNz\nat /Users/alice/.ssh/id_rsa" }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "API_KEY=super-secret Cookie: sid=cookie-secret; refresh=also-secret\n/home/bob/private.txt" }] } },
	]);
	const serialized = JSON.stringify(history);
	for (const visible of ["abcdefghijklmnop", "super-secret", "dXNlcjpwYXNz", "cookie-secret", "also-secret", "/Users/alice", "/home/bob"]) assert.match(serialized, new RegExp(visible.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("session chat history bounds recent entries and text with explicit truncation metadata", () => {
	const records = [
		{ type: "message", id: "old", message: { role: "user", content: "old" } },
		{ type: "message", id: "new", message: { role: "assistant", content: [{ type: "text", text: "123456789" }, { type: "toolCall", id: "call-2", name: "read", arguments: { path: "/secret" } }] } },
	];
	const history = normalizeSessionChatHistory(records, { maxEntries: 1, maxTextChars: 5 });
	assert.deepEqual(history.entries, [{ id: "new", role: "assistant", content: [{ type: "text", text: "12345", truncated: true }, { type: "toolCall", id: "call-2", name: "read", arguments: { path: "/secret" } }] }]);
	assert.deepEqual(history.metadata, { sourceEntries: 2, displayableEntries: 2, returnedEntries: 1, omittedEntries: 1, truncated: true, contentTruncated: true });
});

test("session summaries normalize, query, and sort listAll-shaped records", () => {
	const result = summarizeSessions([
		{ file: "/sessions/old.jsonl", name: "Alpha", cwd: "/a", modified: 1 },
		{ id: "new", name: "Beta", cwd: "/b", modified: 2 },
	], "bEt");
	assert.deepEqual(result.map((session) => session.id), ["new"]);
	assert.deepEqual(summarizeSessions([{ id: "old", modified: 1 }, { id: "new", modified: 2 }]).map((session) => session.id), ["new", "old"]);
});

test("session tree follows cwd directory hierarchy and aggregates descendants", () => {
	const tree = buildSessionTree([
		{ id: "older", cwd: "/Users/dev/Code/alpha", modified: "2026-01-01T00:00:00Z" },
		{ id: "newer", cwd: "/Users/dev/Code/alpha", modified: "2026-01-03T00:00:00Z" },
		{ id: "beta", cwd: "/Users/dev/Code/beta", modified: "2026-01-02T00:00:00Z" },
	]);
	assert.equal(tree.length, 1);
	assert.equal(tree[0].name, "/");
	assert.equal(tree[0].sessionCount, 3);
	assert.equal(tree[0].modified, "2026-01-03T00:00:00Z");
	const code = tree[0].children[0].children[0].children[0];
	assert.deepEqual(code.children.map((node) => node.name), ["alpha", "beta"]);
	assert.deepEqual(code.children[0].sessions.map((session) => session.id), ["newer", "older"]);
});

test("session tree supports Windows cwd and groups missing cwd", () => {
	const tree = buildSessionTree([
		{ id: "windows", cwd: "C:\\work\\repo", modified: 3 },
		{ id: "unknown", cwd: "", modified: 4 },
	]);
	assert.deepEqual(tree.map((node) => node.name), ["C:", "Unknown project"]);
	assert.equal(tree[0].children[0].children[0].sessions[0].id, "windows");
	assert.equal(tree[1].sessions[0].id, "unknown");
});

test("session rename validates names and revisions before invoking native mutation", () => withTempDir("pi-web-session-rename-", (directory) => {
	const file = join(directory, "session.jsonl");
	writeFileSync(file, '{"type":"session","id":"s1"}\n');
	const revision = sha256Revision(readFileSync(file));
	const result = renameSessionWithRevision(file, "  New\nName  ", revision, (name) => {
		writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ type: "session_info", name })}\n`);
	});
	assert.equal(result.name, "New Name");
	assert.notEqual(result.revision, revision);
	assert.match(readFileSync(file, "utf8"), /"name":"New Name"/);
	assert.throws(() => renameSessionWithRevision(file, "Other", revision, () => {}), (error) => error.code === "REVISION_CONFLICT");
	assert.throws(() => renameSessionWithRevision(file, " \n ", result.revision, () => {}), (error) => error.code === "INVALID_SESSION_NAME");
}));

test("session delete validates revision before invoking removal", () => withTempDir("pi-web-session-delete-", (directory) => {
	const file = join(directory, "session.jsonl");
	writeFileSync(file, '{"type":"session","id":"s1"}\n');
	const revision = sha256Revision(readFileSync(file));
	assert.throws(() => removeSessionWithRevision(file, "0".repeat(64), () => {}), (error) => error.code === "REVISION_CONFLICT");
	const result = removeSessionWithRevision(file, revision, () => rmSync(file));
	assert.equal(result.revision, revision);
	assert.equal(result.deleted, true);
}));
