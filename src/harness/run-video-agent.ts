import { runVideoAgent } from "./video-agent";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort(new Error("Interrupted by SIGINT.")));
process.once("SIGTERM", () => controller.abort(new Error("Interrupted by SIGTERM.")));

runVideoAgent(process.argv.slice(2), controller.signal)
  .then((result) => {
    console.log(`\n[harness] run: ${result.runId}`);
    console.log(`[harness] output: ${result.outputPath}`);
    console.log(`[harness] passed: ${result.passed}`);
    if (!result.passed) process.exitCode = 2;
  })
  .catch((error) => {
    console.error(`\n[harness] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
