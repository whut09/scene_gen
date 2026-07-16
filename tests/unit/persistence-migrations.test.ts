import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readMediaCacheMetadata } from "../../src/cache/media-cache";
import { readRunJournal } from "../../src/harness/run-journal";
import { readHtmlVideoContentGraph } from "../../src/html-video/content-graph";
import { readProductionReport } from "../../src/production/production-report";
import { migrateRunArtifacts } from "../../src/persistence/run-migration";
import { fromRoot, readJson } from "../../src/pipeline/utils";

const fixtureDir = fromRoot("tests", "fixtures", "persistence");
const fixture = (name: string) => readJson<unknown>(path.join(fixtureDir, name));

test("N-1 fixtures migrate to current schemas", async () => {
  const journal = readRunJournal(await fixture("run-journal-v1.json"));
  assert.equal(journal.migratedFrom, 1);
  assert.equal(journal.value.specVersion, 2);
  assert.equal(journal.value.migrationHistory[0].fromVersion, 1);

  const cache = readMediaCacheMetadata(await fixture("media-cache-metadata-v1.json"));
  assert.equal(cache.value.metadataVersion, 2);
  assert.equal(cache.value.identityVersion, 1);
  assert.equal(cache.value.identity.model, "legacy-model");

  const report = readProductionReport(await fixture("production-report-v1.json"));
  assert.equal(report.value.specVersion, 2);
  assert.equal(report.value.projectTitle, "Legacy report");

  const graph = readHtmlVideoContentGraph(await fixture("content-graph-v1.json"));
  assert.equal(graph.value.specVersion, 2);
  assert.equal(graph.value.nodes[0].variantId.length > 0, true);
  assert.equal(graph.value.nodes[0].data.type, "title");
});

test("unsupported future and missing migration versions return friendly errors", async () => {
  const raw = await fixture("run-journal-v1.json") as Record<string, unknown>;
  assert.throws(() => readRunJournal({ ...raw, specVersion: 99 }), /newer than supported version 2/);
  assert.throws(() => readRunJournal({ ...raw, specVersion: 0 }), /no valid integer specVersion/);
});

test("run migration backs up and atomically upgrades related artifacts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-migrate-"));
  try {
    const runPath = path.join(directory, "run.json");
    const graphPath = path.join(directory, "content-graph.json");
    const reportPath = path.join(directory, "production-report.json");
    const manifestPath = path.join(directory, "manifest.json");
    const run = await fixture("run-journal-v1.json") as Record<string, unknown>;
    await writeFile(graphPath, await readFile(path.join(fixtureDir, "content-graph-v1.json"), "utf8"), "utf8");
    await writeFile(reportPath, await readFile(path.join(fixtureDir, "production-report-v1.json"), "utf8"), "utf8");
    await writeFile(manifestPath, JSON.stringify([{ index: 1, title: "Legacy", source: "fixture", sourceUrl: "https://example.com", score: 1, projectPath: path.join(directory, "project.json"), htmlVideoGraphPath: graphPath, productionReportPath: reportPath, outputPath: path.join(directory, "output.mp4") }]), "utf8");
    await writeFile(runPath, JSON.stringify({ ...run, artifacts: { manifestPath } }), "utf8");

    const result = await migrateRunArtifacts(directory);
    assert.equal(result.migratedCount, 3);
    assert.equal(existsSync(`${runPath}.v1.bak`), true);
    assert.equal(existsSync(`${graphPath}.v1.bak`), true);
    assert.equal(existsSync(`${reportPath}.v1.bak`), true);
    assert.equal((await readJson<{ specVersion: number }>(runPath)).specVersion, 2);
    assert.equal((await readJson<{ specVersion: number }>(graphPath)).specVersion, 2);
    assert.equal((await readJson<{ specVersion: number }>(reportPath)).specVersion, 2);

    const repeated = await migrateRunArtifacts(directory);
    assert.equal(repeated.migratedCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
