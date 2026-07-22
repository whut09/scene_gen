import path from "node:path";
import { slugify } from "./utils";

export function videoFileNameFromTitle(title: string) {
  const chineseCount = (title.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (chineseCount < 4) throw new Error("Video title must contain at least four Chinese characters before publishing.");
  return `${slugify(title, "中文视频")}.mp4`;
}

export function provisionalVideoFileName(title: string, fallback = "story") {
  const chineseCount = (title.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return chineseCount >= 4 ? videoFileNameFromTitle(title) : `${slugify(title, fallback)}.mp4`;
}

export function titleBasedVideoPath(outputPath: string, title: string) {
  return path.join(path.dirname(outputPath), videoFileNameFromTitle(title));
}

export function repositoryTitleBasedVideoPath(outputPath: string, title: string) {
  const safeTitle = title.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "");
  if (!safeTitle) throw new Error("Repository video title must be a valid project name.");
  return path.join(path.dirname(outputPath), `${safeTitle}.mp4`);
}
