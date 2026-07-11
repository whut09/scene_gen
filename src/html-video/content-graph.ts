import type { VideoProject, VideoScene } from "../pipeline/types";
import { selectTemplatesForProject } from "../templates/template-registry";
import type { SceneIntent, TemplateMotionFamily } from "../templates/template.schema";

export type HtmlVideoGraphEdgeType = "sequence" | "contrast" | "dependency";

export interface HtmlVideoGraphNode {
  id: string;
  sceneIndex: number;
  sceneType: VideoScene["type"];
  kind: "text" | "data" | "entity";
  intent: SceneIntent;
  frameIntent: string;
  templateId: string;
  templateScore: number;
  templateReasons: string[];
  durationSec: number;
  data: VideoScene;
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
  const selections = selectTemplatesForProject(project);
  const nodes = project.scenes.map((scene, index) => {
    const selection = selections[index];
    return {
      id: "scene-" + String(index + 1).padStart(2, "0"),
      sceneIndex: index,
      sceneType: scene.type,
      kind: nodeKind(scene),
      intent: selection.intent,
      frameIntent: frameIntent(scene, selection.intent),
      templateId: selection.template.id,
      templateScore: selection.score,
      templateReasons: selection.reasons,
      durationSec: scene.duration,
      data: scene,
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
      motionFamilies: [...new Set(selections.map((selection) => selection.template.motionFamily))],
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
