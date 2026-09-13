import { readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const packageDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const committedDir = join(packageDir, "public");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-web-public-"));
const generatedDir = join(temporaryRoot, "public");

async function filesUnder(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push(path.slice(root.length + 1));
  }
  return files;
}

try {
  await build({
    configFile: join(packageDir, "vite.config.ts"),
    root: packageDir,
    mode: "production",
    build: { outDir: generatedDir, emptyOutDir: true },
  });

  if (!(await stat(committedDir).catch(() => null))?.isDirectory()) {
    throw new Error("packages/pi-web/public is missing; run npm run pi-web:build and commit the output");
  }

  const [expectedFiles, actualFiles] = await Promise.all([filesUnder(generatedDir), filesUnder(committedDir)]);
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const missing = expectedFiles.filter((file) => !actualSet.has(file));
  const extra = actualFiles.filter((file) => !expectedSet.has(file));
  const changed = [];
  for (const file of expectedFiles.filter((name) => actualSet.has(name))) {
    const [expected, actual] = await Promise.all([readFile(join(generatedDir, file)), readFile(join(committedDir, file))]);
    if (!expected.equals(actual)) changed.push(file);
  }

  if (missing.length || extra.length || changed.length) {
    const details = [
      ...missing.map((file) => `missing: ${file}`),
      ...extra.map((file) => `extra: ${file}`),
      ...changed.map((file) => `changed: ${file}`),
    ];
    throw new Error(`Committed Pi Web assets do not match a clean production build:\n${details.join("\n")}\nRun npm run pi-web:build and commit packages/pi-web/public/.`);
  }
  console.log(`Verified ${actualFiles.length} committed Pi Web assets against a clean temporary build.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
