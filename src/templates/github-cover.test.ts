import assert from "node:assert/strict";
import test from "node:test";
import { boldSignalTemplate } from "./bold-signal";
import { investmentResearchTemplate } from "./investment-research";
import { kineticTitleTemplate } from "./kinetic-title";

const repositoryUrl = "github.com/example/project";
const project = {
  meta: { title: "项目中文标题", width: 1080, height: 1920, fps: 30, durationSeconds: 10, createdAt: "2026-07-15T00:00:00.000Z", sourceCount: 1 },
  sources: [{ id: "repo", kind: "github", title: "Project", url: `https://${repositoryUrl}`, source: "GitHub", summary: "项目摘要", score: 1, tags: [], repo: "example/project" }],
};
const scene = { type: "title", duration: 10, kicker: "项目速览", headline: "项目中文标题", subhead: "项目摘要", sources: [repositoryUrl] };

for (const template of [kineticTitleTemplate, boldSignalTemplate, investmentResearchTemplate]) {
  test(`${template.id} GitHub cover omits recommendation banner and repository URL`, () => {
    const html = template.renderHtml({ project, scene, width: 1080, height: 1920, variantId: template.variants[0].id } as never);
    assert.equal(html.includes("GitHub 开源项目推荐"), false);
    assert.equal(html.includes(repositoryUrl), false);
  });
}

test("bold signal keeps ambient motion active for long title scenes", () => {
  const html = boldSignalTemplate.renderHtml({ project, scene: { ...scene, duration: 30 }, width: 1080, height: 1920, variantId: "minimal-pulse" } as never);
  assert.match(html, /class="bs-motion"/);
  assert.match(html, /animation:bs-orbit-a 8s ease-in-out infinite alternate/);
  assert.equal(boldSignalTemplate.version, "1.4.0");
});
