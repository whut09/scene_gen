import type { HotItem, VideoProject, VideoScene } from "../pipeline/types";
import { boldSignalTemplate } from "./bold-signal";
import { newsBlueBoardTemplate } from "./news-blue-board";
import { nytDataChartTemplate } from "./nyt-data-chart";
import { productStyleAgentFlowTemplate } from "./product-style-agent-flow";
import type { HtmlTemplateDefinition } from "./template.schema";

export const htmlVideoTemplates: HtmlTemplateDefinition[] = [
  boldSignalTemplate,
  newsBlueBoardTemplate,
  nytDataChartTemplate,
  productStyleAgentFlowTemplate,
];

export function getTemplateById(id: string) {
  return htmlVideoTemplates.find((template) => template.id === id);
}

function primarySource(project: VideoProject): HotItem | undefined {
  return project.sources[0];
}

export function selectTemplateForScene(scene: VideoScene, project: VideoProject): HtmlTemplateDefinition {
  const source = primarySource(project);
  const tags = new Set([...(source?.tags ?? []), source?.kind ?? "", scene.type].map((tag) => tag.toLowerCase()));

  if (scene.type === "signal_chart" || tags.has("benchmark")) return nytDataChartTemplate;
  if (scene.type === "flow" || scene.type === "github_pulse" || scene.type === "timeline" || tags.has("agent")) {
    return productStyleAgentFlowTemplate;
  }
  if (scene.type === "title" || scene.type === "outro") return boldSignalTemplate;
  return newsBlueBoardTemplate;
}

export function listTemplateMetadata() {
  return htmlVideoTemplates.map(({ renderHtml, ...metadata }) => metadata);
}
