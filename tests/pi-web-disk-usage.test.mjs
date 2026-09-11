import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createDiskUsageService,
	scanDiskUsage,
} from "../packages/pi-web/lib/disk-usage-core.cjs";

async function withFixture(run) {
	const parent = mkdtempSync(path.join(os.tmpdir(), "pi-web-disk-"));
	const root = path.join(parent, ".pi");
	mkdirSync(path.join(root, "dir", "nested"), { recursive: true });
	writeFileSync(path.join(root, "root.txt"), "12345");
	writeFileSync(path.join(root, ".hidden"), "abc");
	writeFileSync(path.join(root, "dir", "a.txt"), "1234567");
	writeFileSync(path.join(root, "dir", "nested", "b.txt"), "12345678901");
	symlinkSync("dir", path.join(root, "dir-link"));
	try { return await run({ parent, root }); }
	finally { rmSync(parent, { recursive: true, force: true }); }
}

test("disk usage recursively totals regular files, hidden files, directories, and symlink lstat size", () => withFixture(async ({ root }) => {
	const linkSize = lstatSync(path.join(root, "dir-link")).size;
	const result = await scanDiskUsage(root, "", { sort: "name", order: "asc", concurrency: 2 });
	assert.equal(result.current.relativePath, "");
	assert.equal(result.totalSize, 26 + linkSize);
	assert.equal(result.fileCount, 4);
	assert.equal(result.directoryCount, 2);
	assert.deepEqual(result.items.map((item) => item.name), [".hidden", "dir", "dir-link", "root.txt"]);
	const directory = result.items.find((item) => item.name === "dir");
	assert.deepEqual({ type: directory.type, size: directory.size, fileCount: directory.fileCount, directoryCount: directory.directoryCount, canDrillDown: directory.canDrillDown }, { type: "directory", size: 18, fileCount: 2, directoryCount: 1, canDrillDown: true });
	const symlink = result.items.find((item) => item.name === "dir-link");
	assert.equal(symlink.type, "symlink");
	assert.equal(symlink.size, linkSize);
	assert.equal(symlink.canDrillDown, false);
	assert.equal(result.partial, false);
	assert.deepEqual(result.diagnostics, []);
	assert.ok(result.items.every((item) => item.percent >= 0 && item.percent <= 100));
}));

test("disk usage supports sorting and directory drill-down breadcrumbs", () => withFixture(async ({ root }) => {
	const old = new Date("2020-01-01T00:00:00.000Z");
	const recent = new Date("2024-01-01T00:00:00.000Z");
	utimesSync(path.join(root, "dir", "a.txt"), old, old);
	utimesSync(path.join(root, "dir", "nested"), recent, recent);
	const bySize = await scanDiskUsage(root, "dir", { sort: "size", order: "desc" });
	assert.equal(bySize.current.relativePath, "dir");
	assert.equal(bySize.parent, "");
	assert.deepEqual(bySize.breadcrumbs, [{ name: ".pi", relativePath: "" }, { name: "dir", relativePath: "dir" }]);
	assert.deepEqual(bySize.items.map((item) => item.name), ["nested", "a.txt"]);
	const byModified = await scanDiskUsage(root, "dir", { sort: "modified", order: "asc" });
	assert.deepEqual(byModified.items.map((item) => item.name), ["a.txt", "nested"]);
	const byType = await scanDiskUsage(root, "", { sort: "type", order: "asc" });
	assert.deepEqual(byType.items.map((item) => item.type), ["directory", "file", "file", "symlink"]);
}));

test("disk usage rejects absolute, NUL, traversal, and symlink drill-down paths", () => withFixture(async ({ root }) => {
	for (const relativePath of [path.resolve(root), "../outside", "dir/../../outside", "dir\0nested"]) {
		await assert.rejects(scanDiskUsage(root, relativePath), (error) => error?.code === "PATH_FORBIDDEN");
	}
	await assert.rejects(scanDiskUsage(root, "dir-link"), (error) => error?.code === "PATH_FORBIDDEN");
}));

test("disk usage service caches scans, coalesces concurrent requests, and refresh bypasses cache", () => withFixture(async ({ root }) => {
	let readdirCalls = 0;
	const fsApi = {
		...fs.promises,
		async readdir(...args) {
			readdirCalls += 1;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return fs.promises.readdir(...args);
		},
	};
	const service = createDiskUsageService({ rootDir: root, ttlMs: 60_000, concurrency: 2, fs: fsApi });
	const [first, duplicate] = await Promise.all([
		service.get("", { sort: "size", order: "desc" }),
		service.get("", { sort: "name", order: "asc" }),
	]);
	assert.equal(first.scannedAt, duplicate.scannedAt);
	assert.equal(readdirCalls, 3);
	writeFileSync(path.join(root, "new.txt"), "new-data");
	const cached = await service.get("", { sort: "name", order: "asc" });
	assert.equal(cached.scannedAt, first.scannedAt);
	assert.equal(cached.items.some((item) => item.name === "new.txt"), false);
	const refreshed = await service.get("", { sort: "name", order: "asc", refresh: true });
	assert.equal(refreshed.items.some((item) => item.name === "new.txt"), true);
	assert.equal(readdirCalls, 6);
}));

test("disk usage service shares one semaphore across concurrent scans of different paths", () => withFixture(async ({ root }) => {
	let active = 0;
	let peak = 0;
	const fsApi = {
		...fs.promises,
		async lstat(...args) {
			active += 1; peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			try { return await fs.promises.lstat(...args); } finally { active -= 1; }
		},
		async readdir(...args) {
			active += 1; peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			try { return await fs.promises.readdir(...args); } finally { active -= 1; }
		},
	};
	const service = createDiskUsageService({ rootDir: root, ttlMs: 0, concurrency: 2, fs: fsApi });
	await Promise.all([service.get(""), service.get("dir")]);
	assert.ok(peak <= 2, `observed ${peak} concurrent lstat/readdir calls`);
}));

test("disk usage keeps only direct children while descendants contribute aggregates", () => withFixture(async ({ root }) => {
	const result = await scanDiskUsage(root, "", { sort: "name", order: "asc" });
	const directory = result.items.find((item) => item.name === "dir");
	assert.equal(directory.size, 18);
	assert.equal(directory.fileCount, 2);
	assert.equal(directory.directoryCount, 1);
	assert.equal(Object.hasOwn(directory, "children"), false);
	assert.doesNotMatch(JSON.stringify(result), /b\.txt/);
}));

test("disk usage bounds traversal by visited inode, max entries, and max depth", () => withFixture(async ({ root }) => {
	const duplicateFs = {
		...fs.promises,
		async lstat(candidate, ...args) {
			const stat = await fs.promises.lstat(candidate, ...args);
			if (path.basename(candidate) === "nested") return new Proxy(stat, { get(target, key) { return key === "ino" ? lstatSync(path.join(root, "dir")).ino : Reflect.get(target, key); } });
			return stat;
		},
	};
	const visited = await scanDiskUsage(root, "dir", { fs: duplicateFs });
	assert.equal(visited.partial, true);
	assert.ok(visited.diagnostics.some((item) => item.code === "ALREADY_VISITED"));
	assert.equal(visited.totalSize, 7);
	const entries = await scanDiskUsage(root, "", { maxEntries: 2, sort: "name", order: "asc" });
	assert.equal(entries.partial, true);
	assert.equal(entries.items.length, 2);
	assert.ok(entries.diagnostics.some((item) => item.code === "MAX_ENTRIES"));
	const depth = await scanDiskUsage(root, "", { maxDepth: 1 });
	assert.equal(depth.partial, true);
	assert.ok(depth.diagnostics.some((item) => item.code === "MAX_DEPTH" && item.relativePath === "dir/nested"));
	assert.equal(depth.items.find((item) => item.name === "dir").size, 7);
}));

test("disk usage detects a directory swapped to an escaping symlink and discards its entries", () => withFixture(async ({ parent, root }) => {
	const outside = path.join(parent, "outside");
	mkdirSync(outside);
	writeFileSync(path.join(outside, "secret.txt"), "DO_NOT_ENUMERATE");
	let swapped = false;
	let outsideLstat = 0;
	const canonicalDirectory = realpathSync(path.join(root, "dir"));
	const fsApi = {
		...fs.promises,
		async readdir(candidate, options) {
			if (!swapped && path.resolve(candidate) === canonicalDirectory) {
				swapped = true;
				renameSync(candidate, `${candidate}-original`);
				symlinkSync(outside, candidate);
			}
			return fs.promises.readdir(candidate, options);
		},
		async lstat(candidate, ...args) {
			if (path.resolve(candidate).startsWith(path.resolve(outside))) outsideLstat += 1;
			return fs.promises.lstat(candidate, ...args);
		},
	};
	const result = await scanDiskUsage(root, "", { fs: fsApi });
	assert.equal(result.partial, true);
	assert.ok(result.diagnostics.some((item) => item.code === "DIRECTORY_CHANGED" || item.code === "PATH_FORBIDDEN"));
	assert.equal(result.items.find((item) => item.name === "dir").size, 0);
	assert.equal(outsideLstat, 0);
	assert.doesNotMatch(JSON.stringify(result), /secret\.txt|DO_NOT_ENUMERATE/);
}));

test("disk usage returns partial zero results for root or current I/O failures", () => withFixture(async ({ root }) => {
	for (const failedOperation of ["realpath", "lstat", "readdir"]) {
		let failed = false;
		const fsApi = {
			...fs.promises,
			async [failedOperation](...args) {
				if (!failed) { failed = true; throw Object.assign(new Error("I/O failure"), { code: failedOperation === "lstat" ? "EACCES" : "EIO" }); }
				return fs.promises[failedOperation](...args);
			},
		};
		const result = await scanDiskUsage(root, "dir", { fs: fsApi });
		assert.equal(result.partial, true, failedOperation);
		assert.equal(result.totalSize, 0, failedOperation);
		assert.ok(result.diagnostics.some((item) => ["EACCES", "EIO"].includes(item.code)), failedOperation);
	}
}));

test("disk usage ttlMs zero disables completed-result caching", () => withFixture(async ({ root }) => {
	let readdirCalls = 0;
	const fsApi = { ...fs.promises, async readdir(...args) { readdirCalls += 1; return fs.promises.readdir(...args); } };
	const service = createDiskUsageService({ rootDir: root, ttlMs: 0, fs: fsApi });
	await service.get("dir");
	const firstCalls = readdirCalls;
	writeFileSync(path.join(root, "dir", "new.txt"), "new");
	const second = await service.get("dir");
	assert.ok(readdirCalls > firstCalls);
	assert.ok(second.items.some((item) => item.name === "new.txt"));
}));

test("disk usage reports child permission failures as partial diagnostics", () => withFixture(async ({ root }) => {
	const denied = path.join(root, "dir", "a.txt");
	const fsApi = {
		...fs.promises,
		async lstat(candidate, ...args) {
			if (path.resolve(candidate).endsWith(path.join("dir", "a.txt"))) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			return fs.promises.lstat(candidate, ...args);
		},
	};
	const result = await scanDiskUsage(root, "dir", { fs: fsApi });
	assert.equal(result.partial, true);
	assert.equal(result.totalSize, 11);
	assert.equal(result.fileCount, 1);
	assert.deepEqual(result.diagnostics.map((item) => ({ relativePath: item.relativePath, code: item.code })), [{ relativePath: "dir/a.txt", code: "EACCES" }]);
	assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}));
