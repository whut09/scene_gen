import type { VideoScene } from "../pipeline/types";

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function headlineFontSize(text: string, max = 88, min = 58) {
  const length = text.replace(/\s+/g, "").length;
  if (length <= 16) return max;
  if (length <= 24) return Math.max(min, max - 8);
  if (length <= 34) return Math.max(min, max - 16);
  return min;
}

export function pacedDelay(index: number, count: number, durationSec: number, leadSec = 0.7) {
  const available = Math.max(3, durationSec - leadSec - 3);
  const gap = Math.max(0.9, Math.min(3.2, available / Math.max(1, count)));
  return Number((leadSec + index * gap).toFixed(2));
}

export function sceneHeadline(scene: VideoScene) {
  if ("headline" in scene) return scene.headline;
  return "Scene";
}

export function commonHtml({
  title,
  body,
  width,
  height,
  theme = "blue",
  extraCss = "",
  chrome = false,
  durationSec = 12,
}: {
  title: string;
  body: string;
  width: number;
  height: number;
  theme?: "blue" | "dark" | "paper";
  extraCss?: string;
  chrome?: boolean;
  durationSec?: number;
}) {
  const themeCss =
    theme === "paper"
      ? "body{color:#123b56}.hv-kicker{color:#ff5f5f}h1{color:#062f50;text-shadow:none}p{color:#31546c}"
      : "";

  const background =
    theme === "paper"
      ? "linear-gradient(145deg,#fbf7ed 0%,#eef7ff 45%,#fffdf8 100%)"
      : theme === "dark"
        ? "radial-gradient(circle at 25% 18%,rgba(95,230,255,.2),transparent 30%),linear-gradient(150deg,#07111f,#122f52 55%,#121212)"
        : "radial-gradient(circle at 20% 18%,rgba(80,210,255,.34),transparent 26%),radial-gradient(circle at 82% 14%,rgba(85,130,255,.32),transparent 30%),linear-gradient(180deg,#0847d7 0%,#0876ca 48%,#00a6bb 100%)";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=${width}, height=${height}, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; margin: 0; overflow: hidden; }
    body {
      font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", Arial, sans-serif;
      color: #fff;
      background: ${background};
      --scene-duration: ${Math.max(4, durationSec)}s;
      --safe-left: 96px;
      --safe-right: 156px;
      --safe-top: 138px;
      --safe-bottom: 150px;
    }
    .hv-root { position: relative; width: 100%; height: 100%; overflow: hidden; }
    .hv-root::before {
      content: "";
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(rgba(255,255,255,.055) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px);
      background-size: 96px 96px;
      opacity: .16;
      animation: hv-grid-drift var(--scene-duration) linear both;
    }
    .hv-root::after {
      content: "";
      position: absolute;
      z-index: 3;
      top: -20%;
      bottom: -20%;
      left: -38%;
      width: 32%;
      transform: skewX(-12deg);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.11), transparent);
      animation: hv-scene-sweep calc(var(--scene-duration) * .72) 1.4s cubic-bezier(.2,.65,.25,1) both;
      pointer-events: none;
    }
    .hv-top {
      position: absolute;
      z-index: 4;
      top: 54px;
      left: 58px;
      right: 58px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: rgba(255,255,255,.86);
      font-size: 24px;
      font-weight: 800;
      letter-spacing: .04em;
      text-shadow: 0 2px 0 rgba(0,40,120,.2);
    }
    .hv-brand { font-size: 28px; }
    .hv-main {
      position: absolute;
      z-index: 2;
      inset: 130px 58px 92px;
      animation: hv-enter .72s cubic-bezier(.2,.8,.2,1) both;
    }
    .hv-card {
      border: 2px solid rgba(255,255,255,.24);
      background: rgba(255,255,255,.13);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.18), 0 18px 50px rgba(0,44,120,.12);
      backdrop-filter: blur(8px);
    }
    .hv-kicker { color: #fff36a; font-weight: 900; font-size: 28px; margin-bottom: 18px; }
    h1, h2, h3, p { margin: 0; }
    h1 {
      font-size: 78px;
      line-height: 1.12;
      letter-spacing: .02em;
      text-shadow: 0 4px 0 rgba(0,40,120,.25), 0 0 16px rgba(255,255,255,.16);
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .hv-card { position: relative; overflow: hidden; }
    .hv-card::after {
      content: ""; position: absolute; inset: 0 auto 0 -45%; width: 28%; pointer-events: none;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.13), transparent);
      animation: hv-card-scan 7s 2s ease-in-out infinite;
    }
    p { font-size: 34px; line-height: 1.5; color: rgba(255,255,255,.84); }
    @keyframes hv-enter {
      from { opacity: 0; transform: translateY(34px) scale(.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes hv-rise {
      from { opacity: 0; transform: translateY(28px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes hv-width {
      from { transform: scaleX(0); }
      to { transform: scaleX(1); }
    }
    @keyframes hv-grid-drift { from { background-position: 0 0, 0 0; } to { background-position: 72px 110px, 110px 72px; } }
    @keyframes hv-scene-sweep { 0% { transform: translateX(0) skewX(-12deg); opacity: 0; } 12% { opacity: 1; } 100% { transform: translateX(${Math.round(width * 4.8)}px) skewX(-12deg); opacity: 0; } }
    @keyframes hv-card-scan { 0%, 58% { transform: translateX(0); opacity: 0; } 66% { opacity: 1; } 84%, 100% { transform: translateX(520%); opacity: 0; } }
    ${themeCss}
    ${extraCss}
    .hv-main { left: var(--safe-left) !important; right: var(--safe-right) !important; }
    .hv-main, .hv-main * { max-width: 100%; }
  </style>
</head>
<body>
  <div class="hv-root">
    ${chrome ? `<header class="hv-top"><span class="hv-brand">SG</span><span>${escapeHtml(title)}</span><span>HTML Video</span></header>` : ""}
    ${body}
  </div>
</body>
</html>`;
}
