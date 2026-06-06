import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function loadJsonConfig(filePath: string) {
  if (!existsSync(filePath)) return;
  const config = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as Record<
    string,
    string
  >;
  for (const [key, value] of Object.entries(config)) {
    if (!value || value === "xxx" || process.env[key]) continue;
    process.env[key] = value;
  }
}

export function loadLocalConfig() {
  loadEnvFile(resolve(".env"));
  loadEnvFile(resolve(".env.local"));
  loadJsonConfig(resolve("config", "llm.local.json"));
  loadJsonConfig(resolve("config", "llm.example.json"));
}
