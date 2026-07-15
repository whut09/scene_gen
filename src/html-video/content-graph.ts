import type { VideoProject, VideoScene } from "../pipeline/types";
import type { SceneIntent, TemplateMotionFamily } from "../templates/template.schema";
import type { TemplateHistoryStats, TemplateLearningFeatures, TemplateScoreBreakdown } from "../templates/template-learning";
import { buildProductionDecisions } from "../production/visual-planner";
import type { SyncCue, VisualPlan } from "../production/types";
import { highRiskPredicatesInText, qualifiersInText, referencedClaims } from "../pipeline/fact-ledger";

export type HtmlVideoGraphEdgeType = "sequence" | "contrast" | "dependency";

export interface HtmlVideoGraphNode {
  id: string;
  sceneIndex: number;
  sceneType: VideoScene["type"];
  kind: "text" | "data" | "entity";
  intent: SceneIntent;
  frameIntent: string;
  templateId: string;
  variantId: string;
  templateScore: number;
  templateRuleScore: number;
  templateLearnedAdjustment: number;
  templateExplored: boolean;
  templateReasons: string[];
  templateFeatures: TemplateLearningFeatures;
  templateHistory: TemplateHistoryStats;
  templateScoreBreakdown: TemplateScoreBreakdown;
  durationSec: number;
  data: VideoScene;
  visualPlan: VisualPlan;
  syncCues: SyncCue[];
  sourceEvidence: {
    sourceId: string;
    url: string;
    claimIds: string[];
    sourceIds: string[];
    matchedNumbers: string[];
    unmatchedNumbers: string[];
    unsupportedPredicates: string[];
    missingQualifiers: string[];
  };
}

export interface HtmlVideoGraphEdge {
  from: string;
  to: string;
  type: HtmlVideoGraphEdgeType;
  reason?: string;
}

export interface HtmlVideoContentGraph {
  specVersion: 2;
  engine: "html-video-compatible";
  intent: "explainer" | "data-viz" | "comparison" | "promo";
  synopsis: string;
  visualSystem: {
    family: string;
    palette: "ocean-editorial";
    typography: "cn-sans-editorial";
    motionFamilies: TemplateMotionFamily[];
  };
  sourceProject: {
    title: string;
    createdAt: string;
    width: number;
    height: number;
    fps: number;
  };
  nodes: HtmlVideoGraphNode[];
  edges: HtmlVideoGraphEdge[];
}

export interface GraphValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function normalizedNumbers(text: string) {
  return [...new Set((text.match(/\d[\d,.]*(?:%|％)?/g) ?? []).map((value) => value.replace(/,/g, "").replace(/％/g, "%").replace(/[.]$/, "")))];
}

function sceneEvidenceText(scene: VideoScene) {
  switch (scene.type) {
    case "title": return [scene.kicker, scene.headline, scene.subhead, ...scene.sources].join(" ");
    case "briefing_points": return [scene.headline, scene.title, scene.summary, ...scene.metrics.flatMap((item) => [item.label, item.value]), ...scene.points].join(" ");
    case "signal_chart": {
      const bars = Array.isArray(scene.bars) ? scene.bars : [];
      const qualitative = bars.length > 1 && bars.every((bar) => bar.value === bars[0].value);
      return [scene.headline, ...bars.flatMap((bar) => [bar.label, bar.detail, qualitative ? "" : String(bar.value)])].join(" ");
    }
    case "flow": return [scene.headline, ...scene.steps.flatMap((item) => [item.label, item.detail])].join(" ");
    case "outro": return [scene.headline, ...scene.bullets].join(" ");
    case "news_stack": return [scene.headline, ...scene.items.flatMap((item) => [item.title, item.summary])].join(" ");
    case "web_screenshot_zoom": return [scene.headline, ...scene.shots.map((item) => item.title)].join(" ");
    case "timeline": return [scene.headline, ...scene.events.flatMap((item) => [item.date, item.title])].join(" ");
    case "github_pulse": return [scene.headline, ...scene.repos.flatMap((item) => [item.repo, item.title, item.summary, String(item.score)])].join(" ");
  }
}

function sourceEvidence(scene: VideoScene, project: VideoProject) {
  const claims = referencedClaims(project, scene.claimIds);
  const sources = claims.length
    ? project.sources.filter((source) => claims.some((claim) => claim.sourceId === source.id))
    : project.sources;
  const sourceText = (claims.length ? claims.map((claim) => claim.evidenceText) : sources.flatMap((source) => [source.title, source.summary, source.content, source.metrics ? JSON.stringify(source.metrics) : ""]))
    .filter(Boolean).join(" ").replace(/,/g, "").replace(/％/g, "%");
  const sceneText = sceneEvidenceText(scene);
  const numbers = normalizedNumbers(sceneText);
  const matchedNumbers = numbers.filter((value) => sourceText.includes(value));
  const source = sources[0];
  const sceneQualifiers = new Set(qualifiersInText(sceneText));
  return {
    sourceId: source?.id ?? "unknown",
    url: source?.url ?? "",
    claimIds: claims.map((claim) => claim.id),
    sourceIds: sources.map((item) => item.id),
    matchedNumbers,
    unmatchedNumbers: numbers.filter((value) => !matchedNumbers.includes(value)),
    unsupportedPredicates: highRiskPredicatesInText(sceneText).filter((predicate) => !sourceText.includes(predicate)),
    missingQualifiers: [...new Set(claims.flatMap((claim) => claim.qualifiers).filter((qualifier) => !sceneQualifiers.has(qualifier)))],
  };
}
function nodeKind(scene: VideoScene): HtmlVideoGraphNode["kind"] {
  if (scene.type === "signal_chart") return "data";
  if (scene.type === "web_screenshot_zoom" || scene.type === "github_pulse") return "entity";
  return "text";
}

function frameIntent(scene: VideoScene, intent: SceneIntent) {
  if (scene.type === "signal_chart") return "animated-comparison-chart";
  if (scene.type === "flow") return "cause-effect-diagram";
  if (scene.type === "timeline") return "chronological-spine";
  if (scene.type === "web_screenshot_zoom") return "evidence-focus";
  if (scene.type === "briefing_points") return "fact-grid";
  if (scene.type === "title") return "kinetic-headline";
  if (scene.type === "outro") return "takeaway-signal";
  return intent;
}

function graphIntent(project: VideoProject): HtmlVideoContentGraph["intent"] {
  if (project.scenes.filter((scene) => scene.type === "signal_chart").length > 1) return "data-viz";
  if (project.scenes.some((scene) => scene.type === "signal_chart")) return "comparison";
  if (project.meta.durationSeconds <= 45) return "promo";
  return "explainer";
}

export function validateHtmlVideoContentGraph(graph: HtmlVideoContentGraph): GraphValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (graph.nodes.length === 0) errors.push("Graph has no nodes.");
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) errors.push("Duplicate node id: " + node.id);
    ids.add(node.id);
    if (!node.templateId) errors.push("Node has no template: " + node.id);
    if (node.durationSec <= 0) errors.push("Node has invalid duration: " + node.id);
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) errors.push("Edge starts at unknown node: " + edge.from);
    if (!ids.has(edge.to)) errors.push("Edge ends at unknown node: " + edge.to);
    if (edge.from === edge.to) errors.push("Self edge: " + edge.from);
  }
  const uniqueTemplates = new Set(graph.nodes.map((node) => node.templateId)).size;
  if (graph.nodes.length >= 5 && uniqueTemplates < 3) warnings.push("Five-scene video uses fewer than three templates.");
  return { ok: errors.length === 0, errors, warnings };
}

export function topoSortHtmlVideoGraph(graph: HtmlVideoContentGraph) {
  const order = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of graph.edges) {
    if (edge.type !== "dependency" || !indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const ready = [...indegree.entries()].filter(([, value]) => value === 0).map(([id]) => id)
    .sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
  const sorted: string[] = [];
  while (ready.length) {
    const id = ready.shift() as string;
    sorted.push(id);
    for (const target of outgoing.get(id) ?? []) {
      indegree.set(target, (indegree.get(target) ?? 1) - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
      }
    }
  }
  if (sorted.length !== graph.nodes.length) throw new Error("Content graph contains a dependency cycle.");
  return sorted;
}

export function buildHtmlVideoContentGraph(project: VideoProject): HtmlVideoContentGraph {
  const productionDecisions = buildProductionDecisions(project);
  const nodes = project.scenes.map((scene, index) => {
    const selection = productionDecisions[index].templateSelection;
    return {
      id: "scene-" + String(index + 1).padStart(2, "0"),
      sceneIndex: index,
      sceneType: scene.type,
      kind: nodeKind(scene),
      intent: selection.features.intent,
      frameIntent: frameIntent(scene, selection.features.intent),
      templateId: selection.templateId,
      variantId: selection.variantId,
      templateScore: selection.score,
      templateRuleScore: selection.ruleScore,
      templateLearnedAdjustment: selection.learnedAdjustment,
      templateExplored: selection.explored,
      templateReasons: selection.reasons,
      templateFeatures: selection.features,
      templateHistory: selection.history,
      templateScoreBreakdown: selection.scoreBreakdown,
      durationSec: scene.duration,
      data: scene,
      visualPlan: productionDecisions[index].visualPlan,
      syncCues: productionDecisions[index].syncCues,
      sourceEvidence: sourceEvidence(scene, project),
    } satisfies HtmlVideoGraphNode;
  });

  const edges: HtmlVideoGraphEdge[] = nodes.slice(0, -1).map((node, index) => ({
    from: node.id,
    to: nodes[index + 1].id,
    type: "sequence",
    reason: "Narration and scene playback order.",
  }));
  const titleNode = nodes.find((node) => node.sceneType === "title");
  const briefingNode = nodes.find((node) => node.sceneType === "briefing_points" || node.sceneType === "news_stack");
  const chartNode = nodes.find((node) => node.sceneType === "signal_chart");
  const flowNode = nodes.find((node) => node.sceneType === "flow" || node.sceneType === "timeline");
  if (titleNode && briefingNode) edges.push({ from: titleNode.id, to: briefingNode.id, type: "dependency", reason: "The factual briefing expands the opening claim." });
  if (briefingNode && chartNode) edges.push({ from: briefingNode.id, to: chartNode.id, type: "contrast", reason: "The chart compares the facts introduced in the briefing." });
  if (briefingNode && flowNode) edges.push({ from: briefingNode.id, to: flowNode.id, type: "dependency", reason: "The impact path depends on the established facts." });

  const graph: HtmlVideoContentGraph = {
    specVersion: 2,
    engine: "html-video-compatible",
    intent: graphIntent(project),
    synopsis: project.sources[0]?.summary || project.meta.title,
    visualSystem: {
      family: "scene-gen-editorial-v2",
      palette: "ocean-editorial",
      typography: "cn-sans-editorial",
      motionFamilies: [...new Set(productionDecisions.map((decision) => decision.templateSelection.motionFamily))],
    },
    sourceProject: {
      title: project.meta.title,
      createdAt: project.meta.createdAt,
      width: project.meta.width,
      height: project.meta.height,
      fps: project.meta.fps,
    },
    nodes,
    edges,
  };
  const validation = validateHtmlVideoContentGraph(graph);
  if (!validation.ok) throw new Error("Invalid HTML video content graph: " + validation.errors.join("; "));
  topoSortHtmlVideoGraph(graph);
  return graph;
}
