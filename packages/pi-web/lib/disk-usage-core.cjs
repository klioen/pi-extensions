"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SORTS = new Set(["size", "name", "modified", "type"]);
const ORDERS = new Set(["asc", "desc"]);
const RECOVERABLE_CODES = new Set(["EACCES", "EPERM", "EIO"]);
const DEFAULT_MAX_ENTRIES = 200_000;
const DEFAULT_MAX_DEPTH = 64;

function forbidden(message) {
	return Object.assign(new Error(message), { code: "PATH_FORBIDDEN" });
}

function invalid(message) {
	return Object.assign(new Error(message), { code: "INVALID_DISK_USAGE_QUERY" });
}

function normalizeRelativePath(value = "") {
	if (typeof value !== "string" || value.includes("\0") || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\\")) throw forbidden("Disk usage path must be relative");
	const segments = value.split("/");
	if (segments.some((segment) => segment === "..")) throw forbidden("Disk usage path cannot escape its root");
	return segments.filter((segment) => segment && segment !== ".").join("/");
}

function isContained(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
	if (value === undefined || value === null) return fallback;
	const number = Number(value);
	if (!Number.isInteger(number) || number < 0) throw invalid("Disk usage limits must be non-negative integers");
	return Math.min(number, maximum);
}

function createSemaphore(limit) {
	const maximum = Math.max(1, Math.min(64, Number(limit) || 16));
	let active = 0;
	const waiting = [];
	async function run(operation) {
		if (active >= maximum) await new Promise((resolve) => waiting.push(resolve));
		active += 1;
		try { return await operation(); }
		finally {
			active -= 1;
			waiting.shift()?.();
		}
	}
	return { run };
}

function diagnostic(relativePath, operation, error) {
	return { relativePath, operation, code: typeof error?.code === "string" ? error.code : "UNKNOWN" };
}

function syntheticDiagnostic(relativePath, operation, code) {
	return { relativePath, operation, code };
}

function identity(stat) {
	return `${String(stat.dev)}:${String(stat.ino)}`;
}

function sameIdentity(left, right) {
	return left && right && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function entryType(stat) {
	if (stat.isSymbolicLink()) return "symlink";
	if (stat.isDirectory()) return "directory";
	if (stat.isFile()) return "file";
	return "other";
}

function emptyAggregate() {
	return { size: 0, fileCount: 0, directoryCount: 0 };
}

function addAggregate(target, source) {
	target.size += source.size;
	target.fileCount += source.fileCount;
	target.directoryCount += source.directoryCount;
}

async function resolveDirectory(rootDir, relativePath, context) {
	const relative = normalizeRelativePath(relativePath);
	const lexicalRoot = path.resolve(rootDir);
	let root;
	try { root = await context.io(() => context.fs.realpath(lexicalRoot)); }
	catch (error) {
		if (!RECOVERABLE_CODES.has(error?.code)) throw error;
		return { partialError: diagnostic("", "realpath", error), root: lexicalRoot, canonical: path.join(lexicalRoot, relative), relative, stat: null };
	}
	let rootStat;
	try { rootStat = await context.io(() => context.fs.lstat(root)); }
	catch (error) {
		if (!RECOVERABLE_CODES.has(error?.code)) throw error;
		return { partialError: diagnostic("", "lstat", error), root, canonical: path.join(root, relative), relative, stat: null };
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw forbidden("Disk usage root must be a directory");
	let candidate = root;
	let candidateStat = rootStat;
	for (const segment of relative ? relative.split("/") : []) {
		candidate = path.join(candidate, segment);
		try { candidateStat = await context.io(() => context.fs.lstat(candidate)); }
		catch (error) {
			if (RECOVERABLE_CODES.has(error?.code)) return { partialError: diagnostic(relative, "lstat", error), root, canonical: candidate, relative, stat: null };
			if (error?.code === "ENOENT") throw Object.assign(new Error("Disk usage path does not exist"), { code: "ENOENT" });
			throw error;
		}
		if (candidateStat.isSymbolicLink()) throw forbidden("Symbolic links cannot be opened");
		if (!candidateStat.isDirectory()) throw forbidden("Disk usage path must be a directory");
	}
	let canonical;
	try { canonical = await context.io(() => context.fs.realpath(candidate)); }
	catch (error) {
		if (RECOVERABLE_CODES.has(error?.code)) return { partialError: diagnostic(relative, "realpath", error), root, canonical: candidate, relative, stat: null };
		throw error;
	}
	if (!isContained(root, canonical)) throw forbidden("Disk usage path is outside its root");
	let canonicalStat;
	try { canonicalStat = await context.io(() => context.fs.lstat(canonical)); }
	catch (error) {
		if (RECOVERABLE_CODES.has(error?.code)) return { partialError: diagnostic(relative, "lstat", error), root, canonical, relative, stat: null };
		throw error;
	}
	if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) throw forbidden("Disk usage path must be a directory");
	if (!sameIdentity(candidateStat, canonicalStat)) throw forbidden("Disk usage path changed during resolution");
	return { root, canonical, relative, stat: canonicalStat };
}

async function verifyDirectory(absolute, relativePath, expectedStat, context) {
	const stat = await context.io(() => context.fs.lstat(absolute));
	if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, expectedStat)) throw Object.assign(new Error("Directory changed during scan"), { code: "DIRECTORY_CHANGED" });
	const canonical = await context.io(() => context.fs.realpath(absolute));
	if (!isContained(context.root, canonical)) throw Object.assign(new Error("Directory escaped disk usage root"), { code: "PATH_FORBIDDEN" });
	const canonicalStat = await context.io(() => context.fs.lstat(canonical));
	if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink() || !sameIdentity(stat, canonicalStat)) throw Object.assign(new Error("Directory changed during scan"), { code: "DIRECTORY_CHANGED" });
	return canonical;
}

async function readStableDirectory(absolute, relativePath, expectedStat, context) {
	try {
		await verifyDirectory(absolute, relativePath, expectedStat, context);
		const entries = await context.io(() => context.fs.readdir(absolute, { withFileTypes: true }));
		await verifyDirectory(absolute, relativePath, expectedStat, context);
		return entries;
	} catch (error) {
		context.diagnostics.push(diagnostic(relativePath, "readdir", error));
		return null;
	}
}

async function scanDirectory(absolute, relativePath, expectedStat, depth, context, retainChildren) {
	const aggregate = emptyAggregate();
	const entries = await readStableDirectory(absolute, relativePath, expectedStat, context);
	if (!entries) return { aggregate, children: retainChildren ? [] : undefined };
	const remaining = Math.max(0, context.maxEntries - context.entryCount);
	const selected = entries.slice(0, remaining);
	context.entryCount += selected.length;
	if (selected.length < entries.length) context.diagnostics.push(syntheticDiagnostic(relativePath, "readdir", "MAX_ENTRIES"));
	const results = await Promise.all(selected.map(async (entry) => {
		const childAbsolute = path.join(absolute, entry.name);
		const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
		let stat;
		try { stat = await context.io(() => context.fs.lstat(childAbsolute)); }
		catch (error) {
			context.diagnostics.push(diagnostic(childRelative, "lstat", error));
			return null;
		}
		const type = entryType(stat);
		const child = {
			name: entry.name, relativePath: childRelative, type,
			size: type === "file" || type === "symlink" ? stat.size : 0,
			fileCount: type === "file" ? 1 : 0,
			directoryCount: 0, modifiedAt: stat.mtime.toISOString(),
		};
		if (type === "directory") {
			child.directoryCount = 0;
			const childDepth = depth + 1;
			if (childDepth > context.maxDepth) context.diagnostics.push(syntheticDiagnostic(childRelative, "readdir", "MAX_DEPTH"));
			else {
				const key = identity(stat);
				if (context.visited.has(key)) context.diagnostics.push(syntheticDiagnostic(childRelative, "readdir", "ALREADY_VISITED"));
				else {
					context.visited.add(key);
					const nested = await scanDirectory(childAbsolute, childRelative, stat, childDepth, context, false);
					child.size = nested.aggregate.size;
					child.fileCount = nested.aggregate.fileCount;
					child.directoryCount = nested.aggregate.directoryCount;
				}
			}
		}
		return child;
	}));
	const children = [];
	for (const child of results) {
		if (!child) continue;
		addAggregate(aggregate, child);
		if (child.type === "directory") aggregate.directoryCount += 1;
		if (retainChildren) children.push(child);
	}
	return { aggregate, children: retainChildren ? children : undefined };
}

async function collectScan(rootDir, relativePath, options = {}) {
	const started = Date.now();
	const context = {
		fs: options.fs ?? fs.promises,
		io: (options.semaphore ?? createSemaphore(options.concurrency)).run,
		diagnostics: [], visited: new Set(), entryCount: 0,
		maxEntries: positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES),
		maxDepth: positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH),
		root: path.resolve(rootDir),
	};
	const resolved = await resolveDirectory(rootDir, relativePath, context);
	context.root = resolved.root;
	const base = {
		rootName: path.basename(resolved.root),
		current: { name: path.basename(resolved.canonical), relativePath: resolved.relative, type: "directory", modifiedAt: resolved.stat?.mtime?.toISOString?.() ?? null },
		aggregate: emptyAggregate(), children: [], diagnostics: context.diagnostics,
		scannedAt: new Date().toISOString(), durationMs: 0,
	};
	if (resolved.partialError) {
		context.diagnostics.push(resolved.partialError);
		base.durationMs = Date.now() - started;
		return base;
	}
	context.visited.add(identity(resolved.stat));
	const scanned = await scanDirectory(resolved.canonical, resolved.relative, resolved.stat, 0, context, true);
	base.aggregate = scanned.aggregate;
	base.children = scanned.children;
	base.durationMs = Date.now() - started;
	return base;
}

function validateDisplayOptions(options = {}) {
	const sort = options.sort ?? "size";
	const order = options.order ?? "desc";
	if (!SORTS.has(sort)) throw invalid("sort must be size, name, modified, or type");
	if (!ORDERS.has(order)) throw invalid("order must be asc or desc");
	return { sort, order };
}

function compareItems(left, right, sort) {
	if (sort === "size") return left.size - right.size;
	if (sort === "modified") return Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt);
	const field = sort === "type" ? "type" : "name";
	return left[field].localeCompare(right[field], undefined, { numeric: true, sensitivity: "base" });
}

function presentScan(scan, options = {}) {
	const { sort, order } = validateDisplayOptions(options);
	const direction = order === "asc" ? 1 : -1;
	const totalSize = scan.aggregate.size;
	const items = scan.children.map((item) => ({
		...item,
		percent: totalSize === 0 ? 0 : (item.size / totalSize) * 100,
		canDrillDown: item.type === "directory",
	})).sort((left, right) => direction * (compareItems(left, right, sort) || left.name.localeCompare(right.name)));
	const segments = scan.current.relativePath ? scan.current.relativePath.split("/") : [];
	const breadcrumbs = [{ name: scan.rootName, relativePath: "" }];
	let accumulated = "";
	for (const segment of segments) {
		accumulated = accumulated ? `${accumulated}/${segment}` : segment;
		breadcrumbs.push({ name: segment, relativePath: accumulated });
	}
	return {
		current: { ...scan.current }, breadcrumbs,
		parent: segments.length === 0 ? null : segments.slice(0, -1).join("/"),
		totalSize, fileCount: scan.aggregate.fileCount, directoryCount: scan.aggregate.directoryCount,
		scannedAt: scan.scannedAt, durationMs: scan.durationMs, items,
		diagnostics: scan.diagnostics.map((item) => ({ ...item })), partial: scan.diagnostics.length > 0,
	};
}

async function scanDiskUsage(rootDir, relativePath = "", options = {}) {
	return presentScan(await collectScan(rootDir, relativePath, options), options);
}

function createDiskUsageService(options = {}) {
	const rootDir = path.resolve(options.rootDir ?? path.join(os.homedir(), ".pi"));
	const ttlMs = options.ttlMs === undefined ? 10_000 : Math.max(0, Number(options.ttlMs) || 0);
	const semaphore = createSemaphore(options.concurrency);
	const scanOptions = { ...options, semaphore };
	const cache = new Map();
	const inflight = new Map();
	async function load(relativePath, refresh) {
		const relative = normalizeRelativePath(relativePath);
		const cached = cache.get(relative);
		if (!refresh && ttlMs > 0 && cached && Date.now() - cached.cachedAt < ttlMs) return cached.scan;
		if (inflight.has(relative)) return inflight.get(relative);
		const promise = collectScan(rootDir, relative, scanOptions).then((scan) => {
			if (ttlMs > 0) cache.set(relative, { cachedAt: Date.now(), scan });
			return scan;
		}).finally(() => inflight.delete(relative));
		inflight.set(relative, promise);
		return promise;
	}
	return {
		rootDir,
		async get(relativePath = "", requestOptions = {}) {
			return presentScan(await load(relativePath, requestOptions.refresh === true), requestOptions);
		},
		clear() { cache.clear(); },
	};
}

module.exports = { createDiskUsageService, normalizeRelativePath, scanDiskUsage };
