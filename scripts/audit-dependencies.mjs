import { spawn } from "node:child_process";

const transientPattern = /audit endpoint returned an error|client network socket|econnreset|enotfound|etimedout|socket hang up|tls connection|network request failed/i;

function runAudit() {
  return new Promise((resolve) => {
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm audit --audit-level=low"], { shell: false })
      : spawn("npm", ["audit", "--audit-level=low"], { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}\n` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

for (let attempt = 1; attempt <= 3; attempt += 1) {
  const result = await runAudit();
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code === 0) process.exit(0);
  if (!transientPattern.test(`${result.stdout}\n${result.stderr}`) || attempt === 3) process.exit(result.code);
  process.stderr.write(`[audit] transient registry failure; retrying (${attempt}/3).\n`);
  await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
}
