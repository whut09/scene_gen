import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fromRoot } from "../../src/pipeline/utils";
import { runIncrementalMediaBenchmark } from "../fixtures/incremental-media-runner";

const outputDir = path.resolve(process.env.MEDIA_BENCHMARK_DIR ?? fromRoot("test-results", "benchmark", "media"));
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const report = await runIncrementalMediaBenchmark(outputDir);
const reportPath = path.join(outputDir, "media-report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ reportPath, ...report }, null, 2));
