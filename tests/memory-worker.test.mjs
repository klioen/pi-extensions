import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workerSource = readFileSync(
	new URL("../packages/memory/worker/worker.cjs", import.meta.url),
	"utf8",
);

test("private memory baseline commits bypass user Git hooks", () => {
	assert.match(
		workerSource,
		/git\(\["commit",\s*"--allow-empty",\s*"--no-verify",\s*"-qm",\s*"memory baseline"\]\)/,
	);
});
