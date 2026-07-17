import type { NarrationSegment, VideoProject, VideoScene } from "../pipeline/types";
import { selectProviderWithAudit } from "./provider-registry";
import type { ProductionDecision, SyncCue, VisualPlan, VisualSource } from "./types";
import { selectTemplatesForProject } from "../templates/template-registry";

function textForScene(scene: VideoScene) {
  switch (scene.type) {
    case "title": return [scene.headline, scene.subhead].join(" ");
    case "briefing_points": return [scene.headline, scene.title, scene.summary, ...scene.points].join(" ");
    case "signal_chart": return [scene.headline, ...scene.bars.flatMap((bar) => [bar.label, bar.detail])].join(" ");
    case "flow": return [scene.headline, ...scene.steps.flatMap((step) => [step.label, step.detail])].join(" ");
    case "outro": return [scene.headline, ...scene.bullets].join(" ");
    case "news_stack": return [scene.headline, ...scene.items.flatMap((item) => [item.title, item.summary])].join(" ");
    case "web_screenshot_zoom": return [scene.headline, ...scene.shots.map((shot) => shot.title)].join(" ");
    case "timeline": return [scene.headline, ...scene.events.flatMap((event) => [event.date, event.title])].join(" ");
    case "github_pulse": return [scene.headline, ...scene.repos.flatMap((repo) => [repo.repo, repo.title, repo.summary])].join(" ");
  }
}

function compactQueries(project: VideoProject, scene: VideoScene) {
  const source = project.sources[0];
  const entities = [source?.repo, source?.domain, ...source?.tags ?? []].filter(Boolean).slice(0, 3);
  return [...new Set([scene.type === "title" ? project.meta.title : scene.headline, ...entities])].map(String).filter((value) => value.length >= 2).slice(0, 4);
}

function available(source: VisualSource, domain: string) {
  const context = { domain };
  if (source === "stock-video") return selectProviderWithAudit("stock-video", ["pexels", "pixabay"], context);
  if (source === "generated-image") return selectProviderWithAudit("image", ["openai-image"], context);
  if (source === "generated-video") return selectProviderWithAudit("video", ["kling"], context);
  if (source === "web-screenshot" || source === "github-ui") return selectProviderWithAudit("browser", ["playwright"], context);
  return selectProviderWithAudit("programmatic", ["html-video", "remotion"], context);
}

export function planVisualSource(project: VideoProject, scene: VideoScene): VisualPlan {
  const source = project.sources[0];
  const domain = source?.kind === "github" ? "software" : source?.domain ?? source?.tags?.[0] ?? "general";
  const isGithub = source?.kind === "github" || Boolean(source?.repo);
  const text = textForScene(scene);
  let desired: VisualSource = "programmatic";
  const rationale: string[] = [];
  if (scene.type === "web_screenshot_zoom") { desired = "web-screenshot"; rationale.push("scene contains verified webpage evidence"); }
  else if (isGithub && (scene.type === "title" || scene.type === "github_pulse" || /界面|仓库|代码|工作流/.test(text))) { desired = "github-ui"; rationale.push("GitHub project benefits from authentic repository or product UI"); }
  else if (scene.type === "signal_chart" || scene.type === "flow" || scene.type === "timeline" || scene.type === "briefing_points") { desired = "programmatic"; rationale.push("structured facts are clearer as editable data-driven graphics"); }
  else if (/发布会|城市|工厂|机器人|汽车|芯片|航天|人物|现场/.test(text)) { desired = "stock-video"; rationale.push("physical subject benefits from real motion footage"); }
  else if (scene.type === "title" && /概念|未来|战略|竞争/.test(text)) { desired = "generated-image"; rationale.push("opening concept can use a generated editorial key visual"); }
  else rationale.push("programmatic layout preserves factual precision and editability");

  const selectedResult = available(desired, domain);
  const selected = selectedResult.selected;
  const fallbackSource: VisualSource = "programmatic";
  const fallbackResult = available(fallbackSource, domain);
  const fallback = fallbackResult.selected;
  if (!selected) rationale.push(desired + " provider is unavailable; deterministic fallback selected");
  const actualSource = selected ? desired : fallbackSource;
  const provider = selected ?? fallback;
  return {
    source: actualSource,
    providerId: provider?.id ?? "html-video",
    fallback: fallbackSource,
    fallbackProviderId: fallback?.id ?? "html-video",
    searchQueries: compactQueries(project, scene),
    rationale,
    motionTargets: scene.type === "title" ? 3 : scene.type === "signal_chart" || scene.type === "flow" ? 5 : 4,
    expectedMotionRatio: scene.type === "web_screenshot_zoom" ? 0.72 : scene.type === "title" ? 0.58 : 0.46,
    providerSelection: selectedResult.audit,
    fallbackSelection: fallbackResult.audit,
  };
}

function compactCue(value: string) {
  return value.replace(/\s+/g, "").replace(/[，。！？；：、]/g, "").trim().slice(0, 14);
}

export function syncCueCandidates(scene: VideoScene) {
  const values: string[] = [];
  switch (scene.type) {
    case "title": values.push(...scene.headline.split(/[，。！？；：\n]/), ...scene.subhead.split(/[，。！？；：\n]/)); break;
    case "briefing_points": values.push(scene.title, ...scene.metrics.flatMap((item) => [item.label, item.value]), ...scene.points); break;
    case "signal_chart": values.push(...scene.bars.flatMap((bar) => [bar.label, bar.detail])); break;
    case "flow": values.push(...scene.steps.flatMap((step) => [step.label, step.detail])); break;
    case "outro": values.push(...scene.bullets, scene.headline); break;
    case "news_stack": values.push(...scene.items.map((item) => item.title)); break;
    case "web_screenshot_zoom": values.push(scene.headline, ...scene.shots.map((shot) => shot.title)); break;
    case "timeline": values.push(...scene.events.flatMap((event) => [event.date, event.title])); break;
    case "github_pulse": values.push(...scene.repos.flatMap((repo) => [repo.repo, repo.title])); break;
  }
  return [...new Set(values.map(compactCue).filter((value) => value.length >= 2))].slice(0, 8);
}

export function buildSyncCues(scene: VideoScene, segment?: NarrationSegment): SyncCue[] {
  const visible = syncCueCandidates(scene);
  const narration = segment?.text ?? "";
  const matched = visible.filter((value) => narration.includes(value));
  const selected = (matched.length >= 2 ? matched : visible).slice(0, 5);
  const sceneStartMs = (segment?.audioStartSeconds ?? 0) * 1000;
  const durationMs = Math.max(1, (segment?.durationSeconds ?? scene.duration) * 1000);
  const aligned = segment?.speechAlignment?.status === "forced" ? segment.speechAlignment.phrases : [];
  return selected.map((text, index) => {
    const phrase = aligned.find((item) => item.phrase === text);
    if (phrase) {
      return {
        text,
        phrase: phrase.phrase,
        startRatio: Number(Math.max(0, Math.min(1, (phrase.audioStartMs - sceneStartMs) / durationMs)).toFixed(3)),
        endRatio: Number(Math.max(0, Math.min(1, (phrase.audioEndMs - sceneStartMs) / durationMs)).toFixed(3)),
        audioStartMs: phrase.audioStartMs,
        audioEndMs: phrase.audioEndMs,
        confidence: phrase.confidence,
        timingSource: "forced-alignment" as const,
        emphasis: index < 2 ? "primary" as const : "secondary" as const,
      };
    }
    return {
      text,
      startRatio: Number(((index + 0.35) / Math.max(1, selected.length)).toFixed(3)),
      endRatio: Number(((index + 0.8) / Math.max(1, selected.length)).toFixed(3)),
      timingSource: "estimated-ratio" as const,
      emphasis: index < 2 ? "primary" as const : "secondary" as const,
    };
  });
}

export function buildProductionDecisions(project: VideoProject): ProductionDecision[] {
  const selections = selectTemplatesForProject(project);
  return project.scenes.map((scene, sceneIndex) => {
    const selection = selections[sceneIndex];
    return {
      sceneIndex,
      sceneType: scene.type,
      visualPlan: planVisualSource(project, scene),
      syncCues: buildSyncCues(scene, project.narrationSegments?.find((segment) => segment.sceneIndex === sceneIndex)),
      templateSelection: {
        templateId: selection.template.id,
        variantId: selection.variantId,
        motionFamily: selection.template.motionFamily,
        score: selection.score,
        ruleScore: selection.ruleScore,
        learnedAdjustment: selection.learnedAdjustment,
        explored: selection.explored,
        reasons: selection.reasons,
        features: selection.features,
        history: selection.history,
        scoreBreakdown: selection.scoreBreakdown,
      },
    };
  });
}
