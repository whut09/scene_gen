import type { HotItem, VideoProject, VideoScene } from "../pipeline/types";
import { boldSignalTemplate } from "./bold-signal";
import { decisionFlowTemplate } from "./decision-flow";
import { editorialStatGridTemplate } from "./editorial-stat-grid";
import { kineticTitleTemplate } from "./kinetic-title";
import { newsBlueBoardTemplate } from "./news-blue-board";
import { nytDataChartTemplate } from "./nyt-data-chart";
import { productStyleAgentFlowTemplate } from "./product-style-agent-flow";
import type {
  HtmlTemplateDefinition,
  SceneIntent,
  TemplateDataDensity,
  TemplateSelection,
} from "./template.schema";

export const htmlVideoTemplates: HtmlTemplateDefinition[] = [
  boldSignalTemplate,
  kineticTitleTemplate,
  newsBlueBoardTemplate,
  editorialStatGridTemplate,
  nytDataChartTemplate,
  productStyleAgentFlowTemplate,
  decisionFlowTemplate,
];

export function getTemplateById(id: string) {
  return htmlVideoTemplates.find((template) => template.id === id);
}

function primarySource(project: VideoProject): HotItem | undefined {
  return project.sources[0];
}

export function sceneIntent(scene: VideoScene): SceneIntent {
  switch (scene.type) {
    case "title": return "hook";
    case "news_stack":
    case "briefing_points": return "briefing";
    case "signal_chart": return "comparison";
    case "web_screenshot_zoom": return "evidence";
    case "timeline": return "timeline";
    case "github_pulse": return "repository";
    case "flow": return "workflow";
    case "outro": return "summary";
  }
}

function sceneDensity(scene: VideoScene): TemplateDataDensity {
  switch (scene.type) {
    case "title": return "low";
    case "outro":
    case "web_screenshot_zoom": return "medium";
    default: return "high";
  }
}

function aspectForProject(project: VideoProject) {
  const ratio = project.meta.width / project.meta.height;
  if (Math.abs(ratio - 9 / 16) < 0.04) return "9:16";
  if (Math.abs(ratio - 16 / 9) < 0.04) return "16:9";
  if (Math.abs(ratio - 1) < 0.04) return "1:1";
  return project.meta.width + ":" + project.meta.height;
}

function searchableTerms(scene: VideoScene, project: VideoProject) {
  const source = primarySource(project);
  return [
    scene.type,
    sceneIntent(scene),
    source?.kind ?? "",
    source?.title ?? "",
    source?.summary ?? "",
    JSON.stringify(scene),
    ...(source?.tags ?? []),
  ].join(" ").toLowerCase();
}

function stableJitter(value: string, max = 3) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (((hash >>> 0) % 1001) / 1000) * max;
}

function selectVariant(template: HtmlTemplateDefinition, terms: string, project: VideoProject, sceneIndex: number, sceneType: VideoScene["type"]) {
  const ranked = template.variants.map((variant) => {
    const tagMatches = variant.tags.filter((tag) => terms.includes(tag.toLowerCase()));
    const bestForMatches = variant.bestFor.filter((item) =>
      item.toLowerCase().split(/\W+/).filter(Boolean).some((token) => token.length > 2 && terms.includes(token)),
    );
    const sceneSpecificScore = variant.tags.some((tag) => tag.toLowerCase() === sceneType.toLowerCase()) ? 30 : 0;
    const semanticScore = tagMatches.length * 8 + bestForMatches.length * 3 + sceneSpecificScore;
    const diversityScore = stableJitter(project.meta.title + ":" + sceneIndex + ":" + template.id + ":" + variant.id, 10);
    return { variant, score: semanticScore + diversityScore, tagMatches };
  }).sort((left, right) => right.score - left.score || left.variant.id.localeCompare(right.variant.id));
  return ranked[0] ?? { variant: { id: "default", name: "Default", tags: [], bestFor: [] }, score: 0, tagMatches: [] };
}

export function rankTemplatesForScene(
  scene: VideoScene,
  project: VideoProject,
  options: {
    sceneIndex?: number;
    previousTemplateId?: string;
    usageCounts?: ReadonlyMap<string, number>;
  } = {},
): TemplateSelection[] {
  const intent = sceneIntent(scene);
  const density = sceneDensity(scene);
  const aspect = aspectForProject(project);
  const terms = searchableTerms(scene, project);

  return htmlVideoTemplates
    .filter((template) => template.supportedScenes.includes(scene.type))
    .filter((template) => template.license.commercialUse)
    .map((template) => {
      const variant = selectVariant(template, terms, project, options.sceneIndex ?? 0, scene.type);
      let score = 35 + Math.min(16, variant.score);
      const reasons = ["supports " + scene.type, "variant " + variant.variant.id];
      if (variant.tagMatches.length) reasons.push("variant tags " + variant.tagMatches.join(", "));

      if (template.supportedIntents.includes(intent)) {
        score += 22;
        reasons.push("intent " + intent);
      }
      if (template.output.supportedAspects.includes(aspect)) {
        score += 12;
        reasons.push("aspect " + aspect);
      }
      if (template.dataDensity.includes(density)) {
        score += 10;
        reasons.push("density " + density);
      }
      if (scene.duration >= template.output.duration.minSec && scene.duration <= template.output.duration.maxSec) {
        score += 6;
        reasons.push("duration in range");
      } else {
        score -= 4;
      }

      const matchedTags = template.tags.filter((tag) => terms.includes(tag.toLowerCase())).slice(0, 4);
      score += matchedTags.length * 3;
      if (matchedTags.length) reasons.push("tags " + matchedTags.join(", "));

      const discouraged = template.notFor.filter((term) => terms.includes(term.toLowerCase()));
      if (discouraged.length) {
        score -= discouraged.length * 10;
        reasons.push("penalty " + discouraged.join(", "));
      }
      if (options.previousTemplateId === template.id) {
        score -= 32;
        reasons.push("adjacent-repeat penalty");
      }
      const used = options.usageCounts?.get(template.id) ?? 0;
      if (used > 0) {
        score -= used * 9;
        reasons.push("reuse penalty x" + used);
      }

      score += stableJitter(project.meta.title + ":" + (options.sceneIndex ?? 0) + ":" + template.id, 8);
      return {
        template,
        score: Number(Math.max(0, score).toFixed(2)),
        intent,
        variantId: variant.variant.id,
        reasons,
      } satisfies TemplateSelection;
    })
    .sort((left, right) => right.score - left.score || left.template.id.localeCompare(right.template.id));
}

export function selectTemplateForScene(
  scene: VideoScene,
  project: VideoProject,
  options: {
    sceneIndex?: number;
    previousTemplateId?: string;
    usageCounts?: ReadonlyMap<string, number>;
  } = {},
): TemplateSelection {
  const selected = rankTemplatesForScene(scene, project, options)[0];
  if (!selected) throw new Error("No commercial HTML video template supports scene type " + scene.type);
  return selected;
}

export function selectTemplatesForProject(project: VideoProject) {
  const usageCounts = new Map<string, number>();
  let previousTemplateId: string | undefined;
  return project.scenes.map((scene, sceneIndex) => {
    const selection = selectTemplateForScene(scene, project, {
      sceneIndex,
      previousTemplateId,
      usageCounts,
    });
    previousTemplateId = selection.template.id;
    usageCounts.set(selection.template.id, (usageCounts.get(selection.template.id) ?? 0) + 1);
    return selection;
  });
}

export function listTemplateMetadata() {
  return htmlVideoTemplates.map(({ renderHtml, ...metadata }) => metadata);
}
