export type SourceKind = "rss" | "github" | "hackernews" | "webpage" | "seed";
export type ContentType = "news" | "technical-article" | "repository";

export interface HotItem {
  id: string;
  kind: SourceKind;
  title: string;
  url: string;
  source: string;
  summary: string;
  content?: string;
  publishedAt?: string;
  contentType?: ContentType;
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

export interface FactClaim {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  qualifiers: string[];
  sourceId: string;
  evidenceText: string;
  evidenceStart?: number;
  evidenceEnd?: number;
  confidence: number;
}

export interface FactLedger {
  version: 1;
  claims: FactClaim[];
}

export type StoryPlanVisual = "title" | "briefing" | "chart" | "flow" | "outro";

export interface StoryPlanCandidate {
  id: string;
  angle: string;
  title: string;
  titleClaimIds: string[];
  estimatedSeconds: number;
  scenes: Array<{ visual: StoryPlanVisual; purpose: string; focus: string; claimIds: string[] }>;
}

export interface StoryPlanRanking {
  candidate: StoryPlanCandidate;
  fingerprint: string;
  rejectedReasons: string[];
  scores: {
    factCoverage: number;
    titleHook: number;
    informationDiversity: number;
    visualFeasibility: number;
    ttsReadability: number;
    historicalEffect: number;
    total: number;
  };
}

export interface StoryPlanningAudit {
  profile: string;
  requestedCandidates: number;
  selectedCandidateId: string;
  planningMs: number;
  planningTokens: number;
  expansionTokens: number;
  rankings: StoryPlanRanking[];
}

export type VideoScene = (
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
    }
) & { claimIds?: string[] };

export interface NarrationSegment {
  sceneIndex: number;
  text: string;
  ttsText?: string;
  pronunciationOverrides?: import("./pronunciation/compiler").PronunciationOverride[];
  pronunciationPlan?: import("./pronunciation/schema").PronunciationPlan;
  claimIds?: string[];
  audioStartSeconds?: number;
  durationSeconds?: number;
  speechAlignment?: NarrationSpeechAlignment;
  ttsProvider?: string;
  ttsVoice?: string;
  ttsLanguage?: string;
}

export interface SpeechWordTiming {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

export interface SpeechPhraseTiming {
  phrase: string;
  audioStartMs: number;
  audioEndMs: number;
  confidence: number;
  match: "exact" | "fuzzy";
}

export interface NarrationSpeechAlignment {
  version: 1;
  status: "forced" | "failed";
  provider: "whisper";
  transcript: string;
  confidence?: number;
  detectedLanguage?: string;
  languageConfidence?: number;
  words: SpeechWordTiming[];
  phrases: SpeechPhraseTiming[];
  createdAt: string;
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
  factLedger?: FactLedger;
  titleClaimIds?: string[];
  storyPlanning?: StoryPlanningAudit;
  audio?: {
    src: string;
    durationSeconds: number;
    provider: "nvidia" | "azure" | "cloudflare-melotts" | "edge" | "openai" | "local" | "f5" | "mock" | "silent";
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
      leadingSilenceSeconds?: number;
      audioGenerationKey: string;
      providerSelection: string;
      requestMs?: number;
      retryCount?: number;
      billedCharacters?: number;
      providerRequestIds?: string;
      budgetUsedCharacters?: number;
      budgetRemainingCharacters?: number;
      budgetWarning?: boolean;
      pronunciationPlanCount?: number;
      pronunciationUncertainCount?: number;
      selectedProvider?: string;
      providerCandidates?: string;
      pronunciationStrategy?: string;
      quotaConsumed?: number;
      quotaRemaining?: number;
      providerSwitchCount?: number;
      verifierRetryCount?: number;
      avoidedTtsRegenerationCount?: number;
      ttsVoice?: string;
      ttsLanguage?: string;
      ttsSceneVoiceConsistency?: boolean;
    };
    sceneCacheSalts?: Record<string, string>;
    pronunciationPlansPath?: string;
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
