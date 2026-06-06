import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { VideoProject } from "./types";
import { ensureDir, fromRoot } from "./utils";

export async function bundleRemotion() {
  console.log("Bundling Remotion project...");
  const serveUrl = await bundle({
    entryPoint: fromRoot("src", "remotion", "index.tsx"),
    publicDir: fromRoot("public"),
    onProgress: (progress) => {
      if (progress === 1) console.log("Bundle ready.");
    },
  });
  return serveUrl;
}

export async function renderProject(project: VideoProject, outputPath: string, serveUrl: string) {
  await ensureDir(path.dirname(outputPath));
  console.log(`Selecting composition for ${project.meta.title}...`);
  const composition = await selectComposition({
    serveUrl,
    id: "AIVideo",
    inputProps: { project },
    logLevel: "warn",
  });

  console.log(`Rendering ${outputPath}...`);
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outputPath,
    inputProps: { project },
    overwrite: true,
    logLevel: "warn",
    onProgress: ({ progress }) => {
      const percent = Math.round(progress * 100);
      if (percent % 20 === 0) process.stdout.write(`\r${percent}%`);
    },
  });
  console.log(`\nRendered: ${outputPath}`);
}
