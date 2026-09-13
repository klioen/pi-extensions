import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactNames = new Set(["intent.md", "spec.md", "plan.md"]);
const ignoredDirectories = new Set([".git", "node_modules"]);

function collectArtifacts(directory = root) {
	const artifacts = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
		const absolutePath = join(directory, entry.name);
		if (entry.isDirectory()) artifacts.push(...collectArtifacts(absolutePath));
		else if (entry.isFile() && artifactNames.has(entry.name)) artifacts.push(relative(root, absolutePath));
	}
	return artifacts.sort();
}

const skillPaths = [
	"packages/sdlc/skills/sdlc-plan/SKILL.md",
	"packages/sdlc/skills/sdlc-build/SKILL.md",
	"packages/sdlc/skills/sdlc-maintain/SKILL.md",
	"packages/sdlc/skills/sdlc-review/SKILL.md",
	"packages/sdlc/skills/sdlc-test/SKILL.md",
];

test("SDLC artifacts live as complete triples under docs/<change-slug>", () => {
	const artifacts = collectArtifacts();
	assert.ok(artifacts.length > 0, "expected at least one SDLC artifact");
	const artifactsByDirectory = new Map();
	for (const artifact of artifacts) {
		assert.match(
			artifact,
			/^docs\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:intent|spec|plan)\.md$/,
			`${artifact} must use docs/<kebab-case-change-slug>/<artifact>.md`,
		);
		const [docs, changeSlug, filename] = artifact.split("/");
		const directory = `${docs}/${changeSlug}`;
		if (!artifactsByDirectory.has(directory)) artifactsByDirectory.set(directory, []);
		artifactsByDirectory.get(directory).push(filename);
	}
	for (const [directory, filenames] of artifactsByDirectory) {
		assert.deepEqual(filenames.sort(), ["intent.md", "plan.md", "spec.md"], `${directory} must contain the complete SDLC triple`);
	}
});

test("every pi-sdlc skill enforces the canonical artifact directory", () => {
	for (const skillPath of skillPaths) {
		const content = readFileSync(join(root, skillPath), "utf8");
		assert.match(content, /docs\/<change-slug>\//, `${skillPath} must name the canonical directory`);
	}
});

test("pi-sdlc no longer permits legacy artifact locations", () => {
	for (const skillPath of skillPaths) {
		const content = readFileSync(join(root, skillPath), "utf8");
		assert.doesNotMatch(content, /随项目约定|仓库根 `intent\/` 目录/, `${skillPath} contains a legacy flexible-location rule`);
	}
	assert.equal(collectArtifacts().some((path) => !path.startsWith("docs/")), false);
});
