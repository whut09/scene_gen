import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { defaultOutputDir, pythonFromVenv } from "./runtime-paths";

test("runtime defaults remain inside the project and venv paths are platform-aware", () => {
  assert.equal(defaultOutputDir().endsWith(path.join("dist", "output")), true);
  const python = pythonFromVenv(path.join("workspace", ".venv"));
  assert.equal(path.isAbsolute(python), false);
  assert.equal(python.includes(process.platform === "win32" ? "Scripts" : "bin"), true);
});
