import { createHash } from "node:crypto";
import { z } from "zod";

export const f5NarrationCacheIdentitySchema = z.object({
  provider: z.literal("f5"),
  model: z.string().min(1),
  normalizedTtsText: z.string().min(1),
  pronunciationLexiconHash: z.string().length(64),
  refAudioHash: z.string().length(64),
  refTextHash: z.string().length(64),
  speed: z.string().min(1),
  nfeStep: z.string().min(1),
  frontendVersion: z.string().min(1),
  cacheSalt: z.string().min(1).optional(),
}).strict();

export const f5NarrationCacheMetadataSchema = f5NarrationCacheIdentitySchema.extend({
  cacheKey: z.string().length(64),
});

export type F5NarrationCacheIdentity = z.infer<typeof f5NarrationCacheIdentitySchema>;
export type F5NarrationCacheMetadata = z.infer<typeof f5NarrationCacheMetadataSchema>;

export function createF5NarrationCacheKey(input: F5NarrationCacheIdentity) {
  const identity = f5NarrationCacheIdentitySchema.parse(input);
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function createF5NarrationCacheMetadata(input: F5NarrationCacheIdentity): F5NarrationCacheMetadata {
  const identity = f5NarrationCacheIdentitySchema.parse(input);
  return f5NarrationCacheMetadataSchema.parse({ ...identity, cacheKey: createF5NarrationCacheKey(identity) });
}
