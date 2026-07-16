import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fromRoot } from "../pipeline/utils";

export function defaultOutputDir() {
  return fromRoot("dist", "output");
}

export function pythonFromVenv(venv: string) {
  const candidates = process.platform === "win32"
    ? [path.join(venv, "Scripts", "python.exe")]
    : [path.join(venv, "bin", "python3"), path.join(venv, "bin", "python")];
  return candidates.find(existsSync) ?? candidates[0];
}

export function resolvePythonCommand(env: NodeJS.ProcessEnv = process.env) {
  if (env.ASR_PYTHON) return env.ASR_PYTHON;
  if (env.F5_TTS_PYTHON) return env.F5_TTS_PYTHON;
  if (env.F5_TTS_VENV) return pythonFromVenv(env.F5_TTS_VENV);
  return process.platform === "win32" ? "python" : "python3";
}

export function resolveF5PythonCommand(env: NodeJS.ProcessEnv = process.env) {
  if (env.F5_TTS_PYTHON) return env.F5_TTS_PYTHON;
  if (env.F5_TTS_VENV) return pythonFromVenv(env.F5_TTS_VENV);
  return process.platform === "win32" ? "python" : "python3";
}

export function resolveF5ReferenceAudio(env: NodeJS.ProcessEnv = process.env) {
  if (env.F5_TTS_REF_AUDIO) return path.resolve(env.F5_TTS_REF_AUDIO);
  const venv = env.F5_TTS_VENV;
  if (!venv) return "";
  const candidates = [path.join(venv, "Lib", "site-packages", "f5_tts", "infer", "examples", "basic", "basic_ref_zh.wav")];
  const libDir = path.join(venv, "lib");
  if (existsSync(libDir)) {
    for (const name of readdirSync(libDir)) candidates.push(path.join(libDir, name, "site-packages", "f5_tts", "infer", "examples", "basic", "basic_ref_zh.wav"));
  }
  return candidates.find(existsSync) ?? "";
}
