import { spawn } from "node:child_process";

export function run(command: string, args: string[], options?: { input?: string; env?: NodeJS.ProcessEnv }) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
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
        "ffprobe",
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

