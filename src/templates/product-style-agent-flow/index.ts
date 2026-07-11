import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, sceneHeadline } from "../html-utils";

export const productStyleAgentFlowTemplate: HtmlTemplateDefinition = {
  id: "product-style-agent-flow",
  name: "Product Style Agent Flow",
  description: "Clean product-demo style flow for agent, repo and workflow scenes.",
  engine: "html-video",
  category: "workflow",
  tags: ["agent", "flow", "github", "product"],
  bestFor: ["agent workflow", "GitHub repo pulse", "product capability chain"],
  supportedScenes: ["flow", "github_pulse", "timeline"],
  output: {
    formats: ["mp4", "webm"],
    defaultFormat: "mp4",
    supportedAspects: ["9:16"],
    fps: [30],
    duration: { type: "variable", minSec: 8, maxSec: 24, defaultSec: 14 },
    audio: false,
  },
  inputs: { schema: { type: "object" }, examples: [] },
  license: {
    spdx: "MIT",
    attributionRequired: false,
    redistributionAllowed: true,
    commercialUse: true,
  },
  renderHtml: ({ scene, width, height }) => {
    const items =
      scene.type === "flow"
        ? scene.steps.map((step) => ({ title: step.label, detail: step.detail }))
        : scene.type === "github_pulse"
          ? scene.repos.map((repo) => ({ title: repo.repo, detail: repo.summary }))
          : scene.type === "timeline"
            ? scene.events.map((event) => ({ title: event.title, detail: `${event.date} / ${event.source}` }))
            : [];
    const body = `<main class="hv-main">
      <div class="hv-kicker">Workflow</div>
      <h1>${escapeHtml(sceneHeadline(scene))}</h1>
      <section style="position:absolute;left:0;right:0;top:280px;display:grid;gap:22px;">
        ${items
          .map(
            (item, index) => `<article class="hv-card" style="display:grid;grid-template-columns:84px 1fr;gap:24px;align-items:center;padding:30px;animation:hv-rise .55s ${index * 0.14}s both;">
              <span style="width:64px;height:64px;border:3px solid rgba(255,255,255,.58);display:grid;place-items:center;font-size:28px;font-weight:900;color:#fff36a;">${String(index + 1).padStart(2, "0")}</span>
              <div><h2 style="font-size:42px;line-height:1.16;margin-bottom:10px;">${escapeHtml(item.title)}</h2>
              <p style="font-size:28px;">${escapeHtml(item.detail)}</p></div>
            </article>`,
          )
          .join("")}
      </section>
    </main>`;
    return commonHtml({ title: sceneHeadline(scene), body, width, height, theme: "dark" });
  },
};
