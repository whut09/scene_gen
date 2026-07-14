import path from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../pipeline/utils";

const stageStatusSchema = z.enum(["pending", "running", "succeeded", "failed"]);

const runStageSchema = z.object({
  name: z.string().min(1),
  status: stageStatusSchema,
  attempt: z.number().int().positive(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  outputs: z.record(z.string(), z.string()).optional(),
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  error: z.string().optional(),
});

export const runJournalSchema = z.object({
  specVersion: z.literal(1),
  runId: z.string().min(1),
  url: z.string().min(1),
  status: z.enum(["running", "succeeded", "failed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  config: z.object({
    targetSeconds: z.number().positive(),
    maxIterations: z.number().int().positive(),
    engine: z.enum(["remotion", "html-video"]),
    outputDir: z.string().min(1),
    screenshotLimit: z.number().int().nonnegative(),
  }),
  artifacts: z.record(z.string(), z.string()),
  stages: z.array(runStageSchema),
  error: z.string().optional(),
});

export type RunJournal = z.infer<typeof runJournalSchema>;
export type RunStage = z.infer<typeof runStageSchema>;

export class RunJournalStore {
  readonly filePath: string;
  private journal: RunJournal;

  private constructor(filePath: string, journal: RunJournal) {
    this.filePath = filePath;
    this.journal = journal;
  }

  static async create(runDir: string, input: Omit<RunJournal, "specVersion" | "status" | "createdAt" | "updatedAt" | "artifacts" | "stages">) {
    const timestamp = new Date().toISOString();
    const journal = runJournalSchema.parse({
      specVersion: 1,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      artifacts: {},
      stages: [],
      ...input,
    });
    const store = new RunJournalStore(path.join(runDir, "run.json"), journal);
    await store.persist();
    return store;
  }

  async setArtifacts(artifacts: Record<string, string>) {
    this.journal.artifacts = { ...this.journal.artifacts, ...artifacts };
    await this.persist();
  }

  async startStage(name: string, attempt = 1) {
    const startedAt = new Date().toISOString();
    this.upsertStage({ name, attempt, status: "running", startedAt });
    await this.persist();
    return startedAt;
  }

  async finishStage(
    name: string,
    attempt: number,
    status: "succeeded" | "failed",
    details: Pick<RunStage, "outputs" | "metrics" | "error"> = {},
  ) {
    const existing = this.journal.stages.find((stage) => stage.name === name && stage.attempt === attempt);
    const completedAt = new Date().toISOString();
    const durationMs = existing?.startedAt
      ? Math.max(0, Date.parse(completedAt) - Date.parse(existing.startedAt))
      : undefined;
    this.upsertStage({
      name,
      attempt,
      status,
      startedAt: existing?.startedAt,
      completedAt,
      durationMs,
      ...details,
    });
    await this.persist();
  }

  async succeed() {
    this.journal.status = "succeeded";
    this.journal.error = undefined;
    await this.persist();
  }

  async fail(error: unknown) {
    this.journal.status = "failed";
    this.journal.error = error instanceof Error ? error.stack ?? error.message : String(error);
    await this.persist();
  }

  private upsertStage(stage: RunStage) {
    const index = this.journal.stages.findIndex((item) => item.name === stage.name && item.attempt === stage.attempt);
    if (index >= 0) this.journal.stages[index] = runStageSchema.parse(stage);
    else this.journal.stages.push(runStageSchema.parse(stage));
  }

  private async persist() {
    this.journal.updatedAt = new Date().toISOString();
    this.journal = runJournalSchema.parse(this.journal);
    await writeJsonAtomic(this.filePath, this.journal);
  }
}
