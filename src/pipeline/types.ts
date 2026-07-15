export type SourceKind = "rss" | "github" | "hackernews" | "webpage" | "seed";

export interface HotItem {
  id: string;
  kind: SourceKind;
  title: string;
  url: string;
  source: string;
  summary: string;
  content?: string;
  publishedAt?: string;
  score: number;
  tags: string[];
  domain?: string;
  repo?: string;
  metrics?: Record<string, number | string>;
}

export interface ProjectAsset {
  id: string;
  kind: "image" | "video";
  role: "hero" | "evidence" | "demo";
  title: string;
  sourceUrl: string;
  src: string;
  contentType: string;
  license: string;
}

export interface WebScreenshot {
  id: string;
  title: string;
  source: string;
  url: string;
  src: string;
  width: number;
  height: number;
  highlight: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export type VideoScene =
  | {
      type: "title";
      duration: number;
      kicker: string;
      headline: string;
      subhead: string;
      sources: string[];
    }
  | {
      type: "news_stack";
      duration: number;
      headline: string;
      items: Array<Pick<HotItem, "title" | "summary" | "source" | "url" | "tags">>;
    }
  | {
      type: "briefing_points";
      duration: number;
      headline: string;
      source: string;
      title: string;
      summary: string;
      points: string[];
      metrics: Array<{ label: string; value: string }>;
    }
  | {
      type: "signal_chart";
      duration: number;
      headline: string;
      bars: Array<{ label: string; value: number; detail: string; color: string }>;
    }
  | {
      type: "web_screenshot_zoom";
      duration: number;
      headline: string;
      shots: WebScreenshot[];
    }
  | {
      type: "timeline";
      duration: number;
      headline: string;
      events: Array<{ date: string; title: string; source: string }>;
    }
  | {
      type: "github_pulse";
      duration: number;
      headline: string;
      repos: Array<{ repo: string; title: string; summary: string; score: number }>;
    }
  | {
      type: "flow";
      duration: number;
      headline: string;
      steps: Array<{ label: string; detail: string }>;
    }
  | {
      type: "outro";
      duration: number;
      headline: string;
      bullets: string[];
    };

export interface NarrationSegment {
  sceneIndex: number;
  text: string;
  ttsText?: string;
  audioStartSeconds?: number;
  durationSeconds?: number;
}

export interface VideoProject {
  meta: {
    title: string;
    createdAt: string;
    width: number;
    height: number;
    fps: number;
    durationSeconds: number;
    sourceCount: number;
  };
  narration: string;
  narrationSegments?: NarrationSegment[];
  audio?: {
    src: string;
    durationSeconds: number;
    provider: "openai" | "local" | "f5" | "silent";
    metrics?: {
      workerStartCount: number;
      workerStartupMs: number;
      modelLoadMs: number;
      queueWaitMs: number;
      synthesisMs: number;
      cacheHitCount: number;
      cacheMissCount: number;
      generatedSceneCount: number;
      reusedSceneCount: number;
      forcedAudioSceneIndexes: string;
      generatedAudioSceneIndexes: string;
      reusedAudioSceneIndexes: string;
      concatenatedAudio: boolean;
      audioGenerationKey: string;
    };
    sceneCacheSalts?: Record<string, string>;
  };
  scenes: VideoScene[];
  sources: HotItem[];
  screenshots?: WebScreenshot[];
  assets?: ProjectAsset[];
  revision?: {
    changedSceneIndexes: number[];
    updatedAt: string;
  };
}

export interface SourceConfig {
  rss: Array<{ name: string; url: string; weight: number }>;
  github: Array<{ repo: string; weight: number }>;
  hackerNews: { queries: string[]; weight: number };
  keywords: string[];
}
