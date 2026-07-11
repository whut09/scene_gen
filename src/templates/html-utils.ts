import type { VideoScene } from "../pipeline/types";

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
}: {
  title: string;
  body: string;
  width: number;
  height: number;
  theme?: "blue" | "dark" | "paper";
}) {
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
  </style>
</head>
<body>
  <div class="hv-root">
    <header class="hv-top"><span class="hv-brand">SG</span><span>${escapeHtml(title)}</span><span>HTML Video</span></header>
    ${body}
  </div>
</body>
</html>`;
}
