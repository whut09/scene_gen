import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fromRoot } from "../../src/pipeline/utils";

test("GitHub CI runs the complete suite on Linux and Windows with Node 20 and 22", async () => {
  const workflow = await readFile(fromRoot(".github", "workflows", "ci.yml"), "utf8");
  const packageJson = JSON.parse(await readFile(fromRoot("package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(workflow, /node: \[20, 22\]/);
  assert.match(workflow, /run: npm run test:ci/);
  assert.match(packageJson.scripts["test:ci"], /npm run test:worker/);
  assert.match(packageJson.scripts["test:ci"], /npm run test:incremental/);
  assert.match(packageJson.scripts["test:ci"], /npm run test:offline/);
  assert.match(packageJson.scripts["test:ci"], /npm run test:golden/);
  assert.equal(packageJson.scripts["test:unit"], "node scripts/run-test-files.mjs src tests/unit");
});
