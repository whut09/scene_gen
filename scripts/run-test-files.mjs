import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

async function collectTests(entryPath) {
  const entries = await readdir(entryPath, { withFileTypes: true });
  const tests = [];
  for (const entry of entries) {
    const childPath = path.join(entryPath, entry.name);
    if (entry.isDirectory()) tests.push(...await collectTests(childPath));
    else if (/\.test\.tsx?$/.test(entry.name)) tests.push(childPath);
  }
  return tests;
}

const roots = process.argv.slice(2);
if (roots.length === 0) throw new Error("Provide at least one test directory.");

const files = (await Promise.all(roots.map(collectTests))).flat().sort();
if (files.length === 0) throw new Error(`No test files found under: ${roots.join(", ")}`);

const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
