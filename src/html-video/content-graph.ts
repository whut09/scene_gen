import type { VideoProject, VideoScene } from "../pipeline/types";
import { selectTemplateForScene } from "../templates/template-registry";

export interface HtmlVideoGraphNode {
  id: string;
  sceneIndex: number;
  sceneType: VideoScene["type"];
  templateId: string;
  durationSec: number;
  data: VideoScene;
}

export interface HtmlVideoGraphEdge {
  from: string;
  to: string;
  type: "sequence";
}

export interface HtmlVideoContentGraph {
  specVersion: 1;
  engine: "html-video-compatible";
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

export function buildHtmlVideoContentGraph(project: VideoProject): HtmlVideoContentGraph {
  const nodes = project.scenes.map((scene, index) => {
    const template = selectTemplateForScene(scene, project);
    return {
      id: `scene-${String(index + 1).padStart(2, "0")}`,
      sceneIndex: index,
      sceneType: scene.type,
      templateId: template.id,
      durationSec: scene.duration,
      data: scene,
    } satisfies HtmlVideoGraphNode;
  });

  return {
    specVersion: 1,
    engine: "html-video-compatible",
    sourceProject: {
      title: project.meta.title,
      createdAt: project.meta.createdAt,
      width: project.meta.width,
      height: project.meta.height,
      fps: project.meta.fps,
    },
    nodes,
    edges: nodes.slice(0, -1).map((node, index) => ({
      from: node.id,
      to: nodes[index + 1].id,
      type: "sequence",
    })),
  };
}
