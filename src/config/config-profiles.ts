import { readFile } from "node:fs/promises";
import { z } from "zod";
import { fromRoot } from "../pipeline/utils";

const profileSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  env: z.record(z.string(), z.string()),
  doctor: z.object({
    requireApi: z.boolean().default(false),
    requireF5: z.boolean().default(false),
    requireWhisper: z.boolean().default(false),
    requireCuda: z.boolean().default(false),
    requireBrowser: z.boolean().default(true),
  }).default({ requireApi: false, requireF5: false, requireWhisper: false, requireCuda: false, requireBrowser: true }),
});

export type ConfigProfile = z.infer<typeof profileSchema>;

export const builtInProfileNames = ["local-f5", "openai-tts", "ci-offline", "fast-preview", "production"] as const;

export async function loadConfigProfile(name: string) {
  const filePath = fromRoot("config", "profiles", `${name}.json`);
  try {
    return profileSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    throw new Error(`Unknown or invalid profile '${name}'. Expected ${builtInProfileNames.join(", ")} or config/profiles/${name}.json. ${(error as Error).message}`);
  }
}

export async function applyConfigProfile(name: string) {
  return loadConfigProfile(name);
}
