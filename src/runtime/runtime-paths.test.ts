import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { defaultOutputDir, pythonFromVenv, resolveF5PythonCommand, resolvePythonCommand } from "./runtime-paths";

test("runtime defaults remain inside the project and venv paths are platform-aware", () => {
  assert.equal(defaultOutputDir().endsWith(path.join("dist", "output")), true);
  const python = pythonFromVenv(path.join("workspace", ".venv"));
  assert.equal(path.isAbsolute(python), false);
  assert.equal(python.includes(process.platform === "win32" ? "Scripts" : "bin"), true);
});

test("ASR Python does not inherit machine-specific F5 paths", () => {
  const env = { F5_TTS_PYTHON: "Z:\\missing-f5\\python.exe", F5_TTS_VENV: "Z:\\missing-f5" };
  assert.equal(resolvePythonCommand(env), process.platform === "win32" ? "python" : "python3");
  assert.equal(resolveF5PythonCommand(env), env.F5_TTS_PYTHON);
  assert.equal(resolvePythonCommand({ ...env, ASR_PYTHON: "C:\\asr\\python.exe" }), "C:\\asr\\python.exe");
});
