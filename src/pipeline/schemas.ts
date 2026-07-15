import { z } from "zod";

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
]);

export const narrationSegmentSchema = z.object({
  sceneIndex: z.number().int().nonnegative(),
  text: z.string(),
  audioStartSeconds: z.number().nonnegative().optional(),
  durationSeconds: z.number().positive().optional(),
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
  audio: z.object({
    src: z.string(),
    durationSeconds: z.number().positive(),
    provider: z.enum(["openai", "local", "f5", "silent"]),
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
  sections: z.array(z.object({
    visual: z.enum(["title", "briefing", "chart", "flow", "outro"]).optional(),
    headline: z.string().optional(),
    kicker: z.string().optional(),
    subhead: z.string().optional(),
    summary: z.string().optional(),
    narration: z.string().optional(),
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
    code: z.string().min(1),
    stage: z.literal("draft"),
    severity: z.enum(["warning", "error"]),
    sceneIndex: z.number().int().nonnegative().optional(),
    evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
    repairAction: z.enum(["none", "regenerate-draft", "revise-scenes", "retry-stage", "check-environment", "resynthesize-audio", "remux", "rerender-scenes", "switch-template", "stop"]),
    retryable: z.boolean(),
  })).optional(),
  revisionNotes: z.array(z.string()).optional(),
});

export const htmlVideoCacheSchema = z.object({
  cacheKey: z.string().optional(),
  detectedMotionSec: z.number().nonnegative().optional(),
  durationSec: z.number().positive().optional(),
});
