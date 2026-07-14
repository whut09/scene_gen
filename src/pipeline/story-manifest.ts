import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeJsonAtomic } from "./utils";

export const storyManifestItemSchema = z.object({
  index: z.number().int().positive(),
  title: z.string().min(1),
  source: z.string(),
  sourceUrl: z.string().optional(),
  score: z.number(),
  projectPath: z.string().min(1),
  htmlVideoGraphPath: z.string().optional(),
  productionReportPath: z.string().optional(),
  outputPath: z.string().min(1),
});

export const storyManifestSchema = z.array(storyManifestItemSchema);

export const generationResultSchema = z.object({
  createdAt: z.string(),
  cacheHit: z.boolean(),
  manifestPath: z.string().min(1),
  stories: storyManifestSchema.min(1),
});

export type StoryManifestItem = z.infer<typeof storyManifestItemSchema>;
export type GenerationResult = z.infer<typeof generationResultSchema>;

export async function readStoryManifest(filePath: string) {
  return storyManifestSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}

export async function writeStoryManifest(filePath: string, manifest: StoryManifestItem[]) {
  await writeJsonAtomic(filePath, storyManifestSchema.parse(manifest));
}
