import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("published tarball installs offline without runtime dependencies and loads in Pi", async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temp = mkdtempSync(join(tmpdir(), "pi-jev-package-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = JSON.parse(execFileSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" }));
  assert.deepEqual(packed[0].files.map((file: { path: string }) => file.path).sort(), ["LICENSE", "README.md", "extensions/jev.ts", "package.json", "src/pruning.ts"]);
  const consumer = join(temp, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  execFileSync(npm, ["install", "--offline", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", join(temp, packed[0].filename)], { cwd: consumer, encoding: "utf8" });
  const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
  assert.equal(Object.keys(lock.packages).length, 2, "only the consumer and this package, no runtime dependency tree");
  const installed = join(consumer, "node_modules/@nourhelmi/pi-jev-compaction");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.ok(manifest.keywords.includes("pi-package"));
  const loader = new DefaultResourceLoader({ cwd: consumer, agentDir: join(temp, "agent"),
    settingsManager: SettingsManager.inMemory(), additionalExtensionPaths: manifest.pi.extensions.map((path: string) => join(installed, path)),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.ok(loader.getExtensions().extensions[0]!.tools.has("jev_read"));
});
