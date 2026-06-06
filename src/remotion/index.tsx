import React from "react";
import { Composition, registerRoot } from "remotion";
import { z } from "zod";
import type { VideoProject } from "../pipeline/types";
import { sampleProject } from "./sample-project";
import { VideoRoot } from "./video-root";

export interface ProjectProps {
  project: VideoProject;
}

const projectSchema: z.ZodType<ProjectProps> = z.object({
  project: z.custom<VideoProject>(),
});

const AnyVideoRoot: React.FC<Record<string, unknown>> = (props) => {
  const project = (props as unknown as ProjectProps).project ?? sampleProject;
  return <VideoRoot project={project} />;
};

const Root = () => {
  return (
    <Composition
      id="AIVideo"
      schema={projectSchema}
      component={AnyVideoRoot}
      defaultProps={{ project: sampleProject }}
      calculateMetadata={({ props }) => {
        const project = (props as ProjectProps).project ?? sampleProject;
        return {
          width: project.meta.width,
          height: project.meta.height,
          fps: project.meta.fps,
          durationInFrames: Math.round(project.meta.durationSeconds * project.meta.fps),
        };
      }}
    />
  );
};

registerRoot(Root);
