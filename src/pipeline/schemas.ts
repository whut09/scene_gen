import { z } from "zod";
import { issueCodeSchema, issueEvidenceSchema, issueSeveritySchema } from "../harness/issue-registry";
import { repairActionSchema } from "../harness/repair-candidate";

const sourceKindSchema = z.enum(["rss", "github", "hackernews", "webpage", "seed"]);

export const hotItemSchema = z.object({
  id: z.string().min(1),
  kind: sourceKindSchema,
  title: z.string(),
  url: z.string(),
  source: z.string(),
  summary: z.string(),
  content: z.string().optional(),
  publishedAt: z.string().optional(),
  score: z.number(),
  tags: z.array(z.string()),
  domain: z.string().optional(),
  repo: z.string().optional(),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
});

export const webScreenshotSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  source: z.string(),
  url: z.string(),
  src: z.string(),
  width: z.number().positive(),
  height: z.number().positive(),
  highlight: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
});

const durationSchema = z.number().positive();
const headlineSchema = z.string().min(1);
const claimIdsSchema = z.array(z.string().min(1));

export const factClaimSchema = z.object({
  id: z.string().min(1), subject: z.string().min(1), predicate: z.string().min(1), value: z.string().min(1),
  qualifiers: z.array(z.string().min(1)), sourceId: z.string().min(1), evidenceText: z.string().min(1),
  evidenceStart: z.number().int().nonnegative().optional(), evidenceEnd: z.number().int().positive().optional(),
  confidence: z.number().min(0).max(1),
}).superRefine((claim, context) => {
  if (claim.evidenceStart !== undefined && claim.evidenceEnd !== undefined && claim.evidenceEnd < claim.evidenceStart) {
    context.addIssue({ code: "custom", path: ["evidenceEnd"], message: "evidenceEnd must not precede evidenceStart." });
  }
});

export const factLedgerSchema = z.object({ version: z.literal(1), claims: z.array(factClaimSchema) });

export const storyPlanVisualSchema = z.enum(["title", "briefing", "chart", "flow", "outro"]);
export const storyPlanCandidateSchema = z.object({
  id: z.string().min(1), angle: z.string().min(1), title: z.string().min(1), titleClaimIds: z.array(z.string().min(1)).min(1),
  estimatedSeconds: z.number().positive(),
  scenes: z.array(z.object({ visual: storyPlanVisualSchema, purpose: z.string().min(1), focus: z.string().min(1), claimIds: z.array(z.string().min(1)).min(1) })).length(5),
});
export const storyPlanResponseSchema = z.object({ candidates: z.array(storyPlanCandidateSchema).min(1).max(4) });
const storyPlanRankingSchema = z.object({
  candidate: storyPlanCandidateSchema, fingerprint: z.string().length(64), rejectedReasons: z.array(z.string()),
  scores: z.object({ factCoverage: z.number(), titleHook: z.number(), informationDiversity: z.number(), visualFeasibility: z.number(), ttsReadability: z.number(), historicalEffect: z.number(), total: z.number() }),
});
const storyPlanningAuditSchema = z.object({
  profile: z.string().min(1), requestedCandidates: z.number().int().min(1).max(4), selectedCandidateId: z.string().min(1),
  planningMs: z.number().nonnegative(), planningTokens: z.number().int().nonnegative(), expansionTokens: z.number().int().nonnegative(), rankings: z.array(storyPlanRankingSchema).min(1),
});

export const videoSceneSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("title"),
    duration: durationSchema,
    kicker: z.string(),
    headline: headlineSchema,
    subhead: z.string(),
    sources: z.array(z.string()),
  }),
  z.object({
    type: z.literal("news_stack"),
    duration: durationSchema,
    headline: headlineSchema,
    items: z.array(z.object({
      title: z.string(),
      summary: z.string(),
      source: z.string(),
      url: z.string(),
      tags: z.array(z.string()),
    })),
  }),
  z.object({
    type: z.literal("briefing_points"),
    duration: durationSchema,
    headline: headlineSchema,
    source: z.string(),
    title: z.string(),
    summary: z.string(),
    points: z.array(z.string()),
    metrics: z.array(z.object({ label: z.string(), value: z.string() })),
  }),
  z.object({
    type: z.literal("signal_chart"),
    duration: durationSchema,
    headline: headlineSchema,
    bars: z.array(z.object({
      label: z.string(),
      value: z.number(),
      detail: z.string(),
      color: z.string(),
    })),
  }),
  z.object({
    type: z.literal("web_screenshot_zoom"),
    duration: durationSchema,
    headline: headlineSchema,
    shots: z.array(webScreenshotSchema),
  }),
  z.object({
    type: z.literal("timeline"),
    duration: durationSchema,
    headline: headlineSchema,
    events: z.array(z.object({ date: z.string(), title: z.string(), source: z.string() })),
  }),
  z.object({
    type: z.literal("github_pulse"),
    duration: durationSchema,
    headline: headlineSchema,
    repos: z.array(z.object({ repo: z.string(), title: z.string(), summary: z.string(), score: z.number() })),
  }),
  z.object({
    type: z.literal("flow"),
    duration: durationSchema,
    headline: headlineSchema,
    steps: z.array(z.object({ label: z.string(), detail: z.string() })),
  }),
  z.object({
    type: z.literal("outro"),
    duration: durationSchema,
    headline: headlineSchema,
    bullets: z.array(z.string()),
  }),
]).and(z.object({ claimIds: claimIdsSchema.optional() }));

export const speechWordTimingSchema = z.object({
  text: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).optional(),
}).refine((value) => value.endMs >= value.startMs, { message: "Speech word endMs must be greater than or equal to startMs." });

export const speechPhraseTimingSchema = z.object({
  phrase: z.string().min(1),
  audioStartMs: z.number().nonnegative(),
  audioEndMs: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  match: z.enum(["exact", "fuzzy"]),
}).refine((value) => value.audioEndMs >= value.audioStartMs, { message: "Speech phrase audioEndMs must be greater than or equal to audioStartMs." });

export const narrationSpeechAlignmentSchema = z.object({
  version: z.literal(1),
  status: z.enum(["forced", "failed"]),
  provider: z.literal("whisper"),
  transcript: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  words: z.array(speechWordTimingSchema),
  phrases: z.array(speechPhraseTimingSchema),
  createdAt: z.string(),
});

export const narrationSegmentSchema = z.object({
  sceneIndex: z.number().int().nonnegative(),
  text: z.string(),
  ttsText: z.string().min(1).optional(),
  claimIds: claimIdsSchema.optional(),
  audioStartSeconds: z.number().nonnegative().optional(),
  durationSeconds: z.number().positive().optional(),
  speechAlignment: narrationSpeechAlignmentSchema.optional(),
});

export const videoProjectSchema = z.object({
  meta: z.object({
    title: z.string().min(1),
    createdAt: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    durationSeconds: z.number().positive(),
    sourceCount: z.number().int().nonnegative(),
  }),
  narration: z.string(),
  narrationSegments: z.array(narrationSegmentSchema).optional(),
  factLedger: factLedgerSchema.optional(),
  titleClaimIds: claimIdsSchema.optional(),
  storyPlanning: storyPlanningAuditSchema.optional(),
  audio: z.object({
    src: z.string(),
    durationSeconds: z.number().positive(),
    provider: z.enum(["openai", "local", "f5", "silent"]),
    metrics: z.object({
      workerStartCount: z.number().int().nonnegative(),
      workerStartupMs: z.number().nonnegative(),
      modelLoadMs: z.number().nonnegative(),
      queueWaitMs: z.number().nonnegative(),
      synthesisMs: z.number().nonnegative(),
      cacheHitCount: z.number().int().nonnegative(),
      cacheMissCount: z.number().int().nonnegative(),
      generatedSceneCount: z.number().int().nonnegative(),
      reusedSceneCount: z.number().int().nonnegative(),
      forcedAudioSceneIndexes: z.string().default(""),
      generatedAudioSceneIndexes: z.string().default(""),
      reusedAudioSceneIndexes: z.string().default(""),
      concatenatedAudio: z.boolean().default(false),
      audioGenerationKey: z.string().default("default"),
      providerSelection: z.string().default("{}"),
    }).optional(),
    sceneCacheSalts: z.record(z.string(), z.string()).optional(),
  }).optional(),
  scenes: z.array(videoSceneSchema).min(1),
  sources: z.array(hotItemSchema).min(1),
  screenshots: z.array(webScreenshotSchema).optional(),
  assets: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(["image", "video"]),
    role: z.enum(["hero", "evidence", "demo"]),
    title: z.string(),
    sourceUrl: z.string(),
    src: z.string(),
    contentType: z.string(),
    license: z.string(),
  })).optional(),
  revision: z.object({
    changedSceneIndexes: z.array(z.number().int().nonnegative()),
    updatedAt: z.string(),
  }).optional(),
}).superRefine((project, context) => {
  const sourceIds = new Set(project.sources.map((source) => source.id));
  const factIds = new Set(project.factLedger?.claims.map((claim) => claim.id) ?? []);
  if (project.factLedger) {
    if (factIds.size !== project.factLedger.claims.length) {
      context.addIssue({ code: "custom", path: ["factLedger", "claims"], message: "Fact claim ids must be unique." });
    }
    project.factLedger.claims.forEach((claim, index) => {
      if (!sourceIds.has(claim.sourceId)) context.addIssue({ code: "custom", path: ["factLedger", "claims", index, "sourceId"], message: `Unknown sourceId ${claim.sourceId}.` });
    });
    const references = [
      ...(project.titleClaimIds ?? []),
      ...project.scenes.flatMap((scene) => scene.claimIds ?? []),
      ...(project.narrationSegments?.flatMap((segment) => segment.claimIds ?? []) ?? []),
    ];
    for (const factId of references) {
      if (!factIds.has(factId)) context.addIssue({ code: "custom", path: ["factLedger"], message: `Unknown fact claim reference ${factId}.` });
    }
  }
  if (project.narrationSegments && project.narrationSegments.length !== project.scenes.length) {
    context.addIssue({
      code: "custom",
      path: ["narrationSegments"],
      message: "Narration segment count must match scene count.",
    });
  }
  project.narrationSegments?.forEach((segment, index) => {
    if (segment.sceneIndex !== index) {
      context.addIssue({
        code: "custom",
        path: ["narrationSegments", index, "sceneIndex"],
        message: `Expected sceneIndex ${index}.`,
      });
    }
  });
});

export const directedStorySchema = z.object({
  title: z.string().optional(),
  titleClaimIds: z.array(z.string().min(1)).min(1),
  sections: z.array(z.object({
    visual: z.enum(["title", "briefing", "chart", "flow", "outro"]).optional(),
    headline: z.string().optional(),
    kicker: z.string().optional(),
    subhead: z.string().optional(),
    summary: z.string().optional(),
    narration: z.string().optional(),
    claimIds: z.array(z.string().min(1)).min(1),
    keywords: z.array(z.string()).optional(),
    metrics: z.array(z.object({ label: z.string().optional(), value: z.string().optional() })).optional(),
    points: z.array(z.string()).optional(),
    bars: z.array(z.object({ label: z.string().optional(), value: z.number().optional(), detail: z.string().optional() })).optional(),
    steps: z.array(z.object({ label: z.string().optional(), detail: z.string().optional() })).optional(),
    bullets: z.array(z.string()).optional(),
  })).optional(),
});

export type DirectedStory = z.infer<typeof directedStorySchema>;

export const sceneRevisionResponseSchema = z.object({
  revisions: z.array(z.object({
    sceneIndex: z.number().int().nonnegative(),
    scene: videoSceneSchema,
    narration: z.string().min(1),
  })),
});

export const qualityJudgeResponseSchema = z.object({
  scores: z.record(z.string(), z.number()).optional(),
  issues: z.array(z.object({
    code: issueCodeSchema,
    stage: z.literal("draft"),
    severity: issueSeveritySchema,
    sceneIndex: z.number().int().nonnegative().optional(),
    evidence: issueEvidenceSchema,
    repairAction: repairActionSchema,
    retryable: z.boolean(),
  })).optional(),
  revisionNotes: z.array(z.string()).optional(),
});

export const htmlVideoCacheSchema = z.object({
  cacheKey: z.string().optional(),
  detectedMotionSec: z.number().nonnegative().optional(),
  durationSec: z.number().positive().optional(),
});
