export const FRAME_DESIGN_VERSION = "scene-gen-frame-v1";

export type FramePalette = "ocean" | "violet" | "sunset" | "mint" | "coral";

export interface FrameTokens {
  canvas: string;
  paper: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  borderStrong: string;
  ink: string;
  muted: string;
  accent: string;
  accentStrong: string;
  accentAlt: string;
  accentTint: string;
  shadow: string;
}

const paletteTokens: Record<FramePalette, FrameTokens> = {
  ocean: {
    canvas: "#f4f8ff", paper: "#f7f5f0", surface: "#ffffff", surfaceAlt: "#eaf1fb",
    border: "#d7e0ec", borderStrong: "#b8c7da", ink: "#142238", muted: "#5c6b7d",
    accent: "#2457d6", accentStrong: "#173d9d", accentAlt: "#087d91", accentTint: "#e4edff", shadow: "rgba(20,34,56,.08)",
  },
  violet: {
    canvas: "#f8f6ff", paper: "#f8f5f1", surface: "#ffffff", surfaceAlt: "#efebfb",
    border: "#dfd9ef", borderStrong: "#c9bee4", ink: "#211b36", muted: "#6c647b",
    accent: "#6945c7", accentStrong: "#4d2b9f", accentAlt: "#8a3ffc", accentTint: "#eee8ff", shadow: "rgba(33,27,54,.08)",
  },
  sunset: {
    canvas: "#fff8f2", paper: "#fbf5ed", surface: "#ffffff", surfaceAlt: "#f7e9dc",
    border: "#eadacf", borderStrong: "#d8bca9", ink: "#2e1b17", muted: "#79645b",
    accent: "#c84c36", accentStrong: "#8f2f29", accentAlt: "#c9792f", accentTint: "#ffebe1", shadow: "rgba(46,27,23,.08)",
  },
  mint: {
    canvas: "#f2faf7", paper: "#f5f8f3", surface: "#ffffff", surfaceAlt: "#e5f3ee",
    border: "#d2e6df", borderStrong: "#b1d1c6", ink: "#132b2a", muted: "#5d7470",
    accent: "#137d78", accentStrong: "#07534f", accentAlt: "#0e8b6c", accentTint: "#ddf3ed", shadow: "rgba(19,43,42,.08)",
  },
  coral: {
    canvas: "#fff5f7", paper: "#fbf3f0", surface: "#ffffff", surfaceAlt: "#f8e5e8",
    border: "#ecd6dc", borderStrong: "#dbb8c2", ink: "#301b25", muted: "#785f68",
    accent: "#ad3162", accentStrong: "#792047", accentAlt: "#c64b5b", accentTint: "#ffe6ed", shadow: "rgba(48,27,37,.08)",
  },
};

export function framePaletteFromText(text: string): FramePalette {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (["ocean", "violet", "sunset", "mint", "coral"] as const)[hash % 5];
}

export function frameTokens(palette: FramePalette) {
  return paletteTokens[palette];
}

export function frameDesignCss(input: {
  width: number;
  height: number;
  durationSec: number;
  palette: FramePalette;
  theme: "blue" | "dark" | "paper";
}) {
  const tokens = frameTokens(input.palette);
  const canvas = input.theme === "paper" ? tokens.paper : tokens.canvas;
  return `
    .sg-frame {
      --sg-bg: ${canvas};
      --sg-surface: ${tokens.surface};
      --sg-surface-alt: ${tokens.surfaceAlt};
      --sg-border: ${tokens.border};
      --sg-border-strong: ${tokens.borderStrong};
      --sg-ink: ${tokens.ink};
      --sg-muted: ${tokens.muted};
      --sg-accent: ${tokens.accent};
      --sg-accent-strong: ${tokens.accentStrong};
      --sg-accent-alt: ${tokens.accentAlt};
      --sg-accent-tint: ${tokens.accentTint};
      --sg-shadow: ${tokens.shadow};
      --sg-frame-width: ${input.width}px;
      --sg-frame-height: ${input.height}px;
      --sg-scene-duration: ${Math.max(4, input.durationSec)}s;
      background: var(--sg-bg) !important;
      color: var(--sg-ink);
      text-rendering: geometricPrecision;
    }
    .sg-frame .hv-root {
      background: var(--sg-bg);
      isolation: isolate;
    }
    .sg-frame .hv-root::before {
      inset: 36px;
      z-index: 0;
      border: 1px solid var(--sg-border);
      background: none;
      opacity: 1;
    }
    .sg-frame .hv-root::after {
      top: 0;
      right: 0;
      bottom: auto;
      left: 0;
      width: auto;
      height: 8px;
      z-index: 7;
      background: var(--sg-accent);
      animation: sg-rule-in .7s cubic-bezier(.2,.8,.2,1) both;
      transform-origin: left center;
    }
    .sg-frame .sg-frame-header,
    .sg-frame .sg-frame-footer {
      position: absolute;
      z-index: 8;
      left: 82px;
      right: 82px;
      display: flex;
      align-items: center;
      color: var(--sg-muted);
      font-family: "IBM Plex Mono", "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 18px;
      line-height: 1;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    .sg-frame .sg-frame-header {
      top: 52px;
      gap: 18px;
    }
    .sg-frame .sg-frame-footer {
      bottom: 50px;
      gap: 16px;
      font-size: 16px;
    }
    .sg-frame .sg-frame-brand {
      color: var(--sg-ink);
      font-weight: 700;
    }
    .sg-frame .sg-frame-rule {
      width: 42px;
      height: 2px;
      background: var(--sg-accent);
    }
    .sg-frame .sg-frame-label {
      margin-left: auto;
      color: var(--sg-accent-strong);
      font-weight: 600;
    }
    .sg-frame .sg-frame-progress {
      width: 94px;
      height: 4px;
      overflow: hidden;
      background: var(--sg-border);
    }
    .sg-frame .sg-frame-progress::after {
      display: block;
      width: 42%;
      height: 100%;
      background: var(--sg-accent);
      content: "";
      animation: sg-progress-in .9s .15s cubic-bezier(.2,.8,.2,1) both;
      transform-origin: left center;
    }
    .sg-frame .hv-top {
      display: none;
    }
    .sg-frame .hv-main {
      top: 148px !important;
      right: 82px !important;
      bottom: 108px !important;
      left: 82px !important;
    }
    .sg-frame .hv-main h1,
    .sg-frame .hv-main h2,
    .sg-frame .hv-main h3 {
      color: var(--sg-ink) !important;
      font-weight: 820;
      letter-spacing: -.035em;
      text-shadow: none !important;
    }
    .sg-frame .hv-main h1 {
      line-height: 1.08;
    }
    .sg-frame .hv-main p,
    .sg-frame .hv-main li,
    .sg-frame .hv-main dd {
      color: var(--sg-muted) !important;
    }
    .sg-frame .hv-kicker,
    .sg-frame .kt-kicker,
    .sg-frame .es-kicker,
    .sg-frame .bs-repository-url,
    .sg-frame .df-kicker {
      color: var(--sg-accent-strong) !important;
      font-family: "IBM Plex Mono", "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: .1em;
      text-transform: uppercase;
    }
    .sg-frame .hv-card,
    .sg-frame .pf-card,
    .sg-frame .df-node,
    .sg-frame .es-lead,
    .sg-frame .es-points li,
    .sg-frame .es-news,
    .sg-frame .ir-card {
      border: 1px solid var(--sg-border) !important;
      border-radius: 12px !important;
      background: var(--sg-surface) !important;
      box-shadow: 0 8px 0 var(--sg-shadow) !important;
      color: var(--sg-ink) !important;
    }
    .sg-frame .nyt-rank,
    .sg-frame .nyt-metric,
    .sg-frame .nyt-delta {
      border: 1px solid var(--sg-border) !important;
      border-radius: 12px !important;
      background: var(--sg-surface) !important;
      box-shadow: 0 8px 0 var(--sg-shadow) !important;
    }
    .sg-frame .nyt-track {
      background: var(--sg-surface-alt) !important;
      border: 1px solid var(--sg-border) !important;
    }
    .sg-frame .nyt-bar-head strong,
    .sg-frame .nyt-bar-head span,
    .sg-frame .nyt-rank span,
    .sg-frame .nyt-rank strong,
    .sg-frame .nyt-metric span,
    .sg-frame .nyt-metric strong,
    .sg-frame .nyt-delta span,
    .sg-frame .nyt-delta strong {
      color: var(--sg-accent-strong) !important;
    }
    .sg-frame .nyt-rank > b,
    .sg-frame .nyt-metric > b { color: var(--sg-accent) !important; }
    .sg-frame .nyt-rank > i,
    .sg-frame .nyt-metric > i,
    .sg-frame .nyt-delta > i { background: var(--sg-accent) !important; }
    .sg-frame .hv-card div,
    .sg-frame .hv-card p,
    .sg-frame .pf-card p,
    .sg-frame .df-node p,
    .sg-frame .ir-card p {
      color: var(--sg-muted) !important;
    }
    .sg-frame .hv-card strong,
    .sg-frame .pf-card h2,
    .sg-frame .df-node b,
    .sg-frame .ir-card strong {
      color: var(--sg-accent-strong) !important;
    }
    .sg-frame .hv-card > span {
      border-radius: 8px !important;
      background: var(--sg-accent) !important;
      color: #fff !important;
    }
    .sg-frame .es-metric {
      border: 0 !important;
      border-radius: 12px !important;
      background: var(--sg-accent) !important;
      box-shadow: 0 8px 0 var(--sg-shadow) !important;
    }
    .sg-frame .es-metric-0 { background: var(--sg-accent-strong) !important; }
    .sg-frame .es-metric-1 { background: var(--sg-accent-alt) !important; }
    .sg-frame .es-metric-2 { background: var(--sg-accent) !important; }
    .sg-frame .es-metric span,
    .sg-frame .es-metric strong,
    .sg-frame .es-metric p {
      color: #fff !important;
    }
    .sg-frame .pf-card > span,
    .sg-frame .df-dot,
    .sg-frame .es-points b,
    .sg-frame .es-news > b {
      color: #fff !important;
      background: var(--sg-accent) !important;
    }
    .sg-frame .pf-core {
      border-radius: 12px !important;
      background: var(--sg-accent) !important;
      box-shadow: 0 8px 0 var(--sg-shadow) !important;
      color: #fff !important;
    }
    .sg-frame .pf-core > * { color: #fff !important; }
    .sg-frame .ge-section,
    .sg-frame .ge-points em,
    .sg-frame .ge-flow em,
    .sg-frame .ge-issue {
      color: var(--sg-accent-strong) !important;
    }
    .sg-frame .ge-issue { border-color: var(--sg-accent) !important; }
    .sg-frame .ge-cover::after { display: none !important; }
    .sg-frame .ge-date,
    .sg-frame .ge-stars {
      border-radius: 8px !important;
      background: var(--sg-accent) !important;
      box-shadow: 0 8px 0 var(--sg-shadow) !important;
      color: #fff !important;
    }
    .sg-frame .ge-date *,
    .sg-frame .ge-stars * { color: #fff !important; }
    .sg-frame .ge-rule { background: var(--sg-accent) !important; }
    .sg-frame .ge-keywords span {
      border: 1px solid var(--sg-border-strong) !important;
      border-radius: 999px !important;
    }
    .sg-frame .ge-lead { border-color: var(--sg-accent-strong) !important; }
    .sg-frame .ge-metrics article {
      border-radius: 12px !important;
      background: var(--sg-accent-strong) !important;
      color: #fff !important;
    }
    .sg-frame .ge-metrics small { color: rgba(255,255,255,.78) !important; }
    .sg-frame .ge-metrics b { color: #fff !important; }
    .sg-frame .ge-flow strong { color: var(--sg-accent-strong) !important; }
    .sg-frame .ge-closing span { background: var(--sg-accent) !important; }
    .sg-frame .kt-index { color: var(--sg-accent) !important; opacity: .12; }
    .sg-frame .kt-asset {
      border: 1px solid var(--sg-border) !important;
      border-radius: 12px !important;
      background: var(--sg-surface) !important;
      box-shadow: 0 8px 0 var(--sg-shadow) !important;
    }
    .sg-frame .kt-rule i { background: var(--sg-accent) !important; }
    .sg-frame .kt-rule i:nth-child(2) { background: var(--sg-accent-alt) !important; }
    .sg-frame .kt-rule i:nth-child(3) { background: var(--sg-accent-strong) !important; }
    .sg-frame .kt-research-stack .kt-support,
    .sg-frame .kt-agent-split .kt-support {
      border-color: var(--sg-accent) !important;
      background: var(--sg-surface-alt) !important;
    }
    .sg-frame .ir-header { border-color: var(--sg-accent-strong) !important; color: var(--sg-accent-strong) !important; }
    .sg-frame .ir-header time { color: var(--sg-accent-strong) !important; }
    .sg-frame .ir-rule { background: var(--sg-surface-alt) !important; }
    .sg-frame .ir-rule i { background: var(--sg-accent) !important; }
    .sg-frame .ir-cover p,
    .sg-frame .ir-card em { color: var(--sg-accent-strong) !important; }
    .sg-frame .ir-cover blockquote { border-color: var(--sg-accent) !important; color: var(--sg-ink) !important; }
    .sg-frame .ir-seal { border-color: var(--sg-accent) !important; color: var(--sg-accent-strong) !important; background: var(--sg-surface) !important; box-shadow: 0 8px 0 var(--sg-shadow) !important; }
    .sg-frame .ir-tape { border-color: var(--sg-accent-strong) !important; background: var(--sg-accent-strong) !important; color: #fff !important; }
    .sg-frame .ir-card i { background: var(--sg-accent) !important; }
    .sg-frame .ir-verdict-ledger .ir-card { background: var(--sg-accent-strong) !important; }
    .sg-frame .bs-motion { opacity: .45; }
    .sg-frame .bs-motion i:nth-child(1),
    .sg-frame .bs-motion i:nth-child(3) { border-color: var(--sg-accent-tint) !important; }
    .sg-frame .bs-motion i:nth-child(2) { background: var(--sg-accent) !important; opacity: .16; }
    .sg-frame .df-spine { background: var(--sg-accent) !important; }
    .sg-frame .kt-date,
    .sg-frame .kt-stars,
    .sg-frame .bs-stars {
      border-radius: 8px;
      background: var(--sg-accent) !important;
      box-shadow: 0 8px 0 var(--sg-shadow) !important;
      color: #fff !important;
    }
    .sg-frame .kt-date *,
    .sg-frame .kt-stars *,
    .sg-frame .bs-stars * { color: #fff !important; }
    .sg-frame .sg-frame-header,
    .sg-frame .sg-frame-footer,
    .sg-frame .hv-main > *,
    .sg-frame .hv-main .hv-card,
    .sg-frame .hv-main .pf-card,
    .sg-frame .hv-main .df-node,
    .sg-frame .hv-main .es-news,
    .sg-frame .hv-main .es-metric,
    .sg-frame .hv-main .ir-card,
    .sg-frame .hv-main .nyt-bar,
    .sg-frame .hv-main .nyt-rank,
    .sg-frame .hv-main .nyt-metric,
    .sg-frame .hv-main .nyt-delta {
      animation-timing-function: cubic-bezier(.2,.8,.2,1);
    }
    .sg-frame .sg-frame-header,
    .sg-frame .sg-frame-footer { animation: none; opacity: 1; }
    @keyframes sg-rule-in {
      from { opacity: 0; transform: scaleX(0); }
      to { opacity: 1; transform: scaleX(1); }
    }
    @keyframes sg-progress-in {
      from { transform: scaleX(0); }
      to { transform: scaleX(1); }
    }
    @keyframes hv-enter {
      from { opacity: 0; transform: translateY(22px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes hv-rise {
      from { opacity: 0; transform: translateY(18px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
}
