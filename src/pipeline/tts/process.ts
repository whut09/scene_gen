import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function resolveMediaTool(toolName: "ffmpeg" | "ffprobe") {
  const configuredPath = toolName === "ffmpeg" ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  const wingetPath = process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", toolName + ".exe")
    : undefined;
  const candidates = [
    configuredPath,
    wingetPath,
    path.resolve(process.cwd(), "node_modules/@remotion/compositor-win32-x64-msvc", toolName + ".exe"),
    path.resolve(process.cwd(), "node_modules/ffprobe-static/bin/win32/x64", toolName + ".exe"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && existsSync(candidate));
  return candidates[0] ?? toolName;
}

export function run(command: string, args: string[], options?: { input?: string; env?: NodeJS.ProcessEnv }) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command === "ffmpeg" ? resolveMediaTool("ffmpeg") : command, args, {
      stdio: options?.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...options?.env },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
    if (options?.input) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
  });
}

export async function probeDuration(filePath: string) {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        resolveMediaTool("ffprobe"),
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath],
        { windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr));
      });
    });
    return Number(output) || 0;
  } catch {
    return 0;
  }
}
