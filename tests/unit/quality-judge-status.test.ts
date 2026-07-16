import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { evaluateDraft } from "../../src/harness/quality";
import { createFixtureProject } from "../fixtures/project";

const judgeEnvKeys = [
  "QUALITY_LLM_DISABLED", "QUALITY_LLM_API_KEY", "QUALITY_LLM_BASE_URL", "QUALITY_LLM_MODEL",
  "NEWS_LLM_API_KEY", "NEWS_LLM_BASE_URL", "NEWS_LLM_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
  "QUALITY_GATE_PROFILE", "QUALITY_JUDGE_SAMPLES", "QUALITY_JUDGE_MAX_SCORE_DELTA",
] as const;

async function withJudgeEnvironment(values: Partial<Record<(typeof judgeEnvKeys)[number], string | undefined>>, run: () => Promise<void>) {
  const previous = Object.fromEntries(judgeEnvKeys.map((key) => [key, process.env[key]]));
  for (const key of judgeEnvKeys) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const key of judgeEnvKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withJudgeServer(responses: Array<Record<string, unknown>>, run: (baseUrl: string) => Promise<void>) {
  let responseIndex = 0;
  const server = createServer((_request, response) => {
    const payload = responses[Math.min(responseIndex, responses.length - 1)];
    responseIndex += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const completeScores = {
  sourceFidelity: 90,
  titleHook: 88,
  informationDensity: 86,
  visualStructure: 84,
  sceneAlignment: 82,
  ttsReadability: 80,
};

test("disabled judge is not required and does not emit fake scores", { concurrency: false }, async () => {
  await withJudgeEnvironment({ QUALITY_LLM_DISABLED: "1", QUALITY_GATE_PROFILE: "lenient" }, async () => {
    const evaluation = await evaluateDraft(createFixtureProject(), 100, "");
    assert.equal(evaluation.scoreStatus, "not-required");
    assert.equal(evaluation.scores, undefined);
    assert.equal(Object.hasOwn(evaluation.metrics, "scoreAverage"), false);
    assert.equal(Object.hasOwn(evaluation.metrics, "scoreMinimum"), false);
    assert.equal(evaluation.issues.some((issue) => issue.code === "judge_unavailable"), false);
  });
});

test("strict profile blocks when judge configuration is unavailable", { concurrency: false }, async () => {
  await withJudgeEnvironment({ QUALITY_GATE_PROFILE: "strict" }, async () => {
    const evaluation = await evaluateDraft(createFixtureProject(), 100, "");
    const issue = evaluation.issues.find((item) => item.code === "judge_unavailable");
    assert.equal(evaluation.scoreStatus, "unavailable");
    assert.equal(evaluation.scores, undefined);
    assert.equal(issue?.severity, "error");
    assert.equal(evaluation.outcome, "blocked");
  });
});

test("lenient profile reports unavailable judge without environment blocking", { concurrency: false }, async () => {
  await withJudgeEnvironment({ QUALITY_GATE_PROFILE: "lenient" }, async () => {
    const evaluation = await evaluateDraft(createFixtureProject(), 100, "");
    const issue = evaluation.issues.find((item) => item.code === "judge_unavailable");
    assert.equal(evaluation.scoreStatus, "unavailable");
    assert.equal(issue?.severity, "warning");
    assert.notEqual(evaluation.outcome, "blocked");
  });
});

test("partial judge scores are averaged only across measured dimensions", { concurrency: false }, async () => {
  await withJudgeServer([{ scores: { sourceFidelity: 80, titleHook: 70 }, issues: [], revisionNotes: [] }], async (baseUrl) => {
    await withJudgeEnvironment({
      QUALITY_GATE_PROFILE: "balanced",
      QUALITY_LLM_API_KEY: "test",
      QUALITY_LLM_BASE_URL: baseUrl,
      QUALITY_LLM_MODEL: "mock",
      QUALITY_JUDGE_SAMPLES: "1",
    }, async () => {
      const evaluation = await evaluateDraft(createFixtureProject(), 100, "");
      assert.equal(evaluation.scoreStatus, "partially-measured");
      assert.deepEqual(evaluation.scores, { sourceFidelity: 80, titleHook: 70 });
      assert.equal(evaluation.metrics.scoreAverage, 75);
      assert.equal(evaluation.metrics.scoreMinimum, 70);
      assert.equal(evaluation.issues.some((issue) => issue.code === "judge_partially_measured"), true);
    });
  });
});

test("strict double sampling marks large judge disagreement as unstable", { concurrency: false }, async () => {
  const lowScores = Object.fromEntries(Object.keys(completeScores).map((key) => [key, 50]));
  await withJudgeServer([
    { scores: completeScores, issues: [], revisionNotes: [] },
    { scores: lowScores, issues: [], revisionNotes: [] },
  ], async (baseUrl) => {
    await withJudgeEnvironment({
      QUALITY_GATE_PROFILE: "strict",
      QUALITY_LLM_API_KEY: "test",
      QUALITY_LLM_BASE_URL: baseUrl,
      QUALITY_LLM_MODEL: "mock",
      QUALITY_JUDGE_MAX_SCORE_DELTA: "15",
    }, async () => {
      const evaluation = await evaluateDraft(createFixtureProject(), 100, "");
      const issue = evaluation.issues.find((item) => item.code === "judge_unstable");
      assert.equal(evaluation.scoreStatus, "measured");
      assert.equal(evaluation.metrics.judgeSamplesCompleted, 2);
      assert.equal(evaluation.metrics.judgeMaxScoreDelta, 40);
      assert.equal(issue?.severity, "error");
      assert.equal(evaluation.passed, false);
    });
  });
});
