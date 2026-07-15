import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import type { VideoProject } from "../../src/pipeline/types";
import { buildHtmlVideoContentGraph } from "../../src/html-video/content-graph";
import { inspectSceneDom } from "../../src/html-video/visual-audit";
import { getTemplateById } from "../../src/templates/template-registry";

const project: VideoProject = {
  meta: { title: "视觉质量门升级", createdAt: "2026-07-15T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 40, sourceCount: 1 },
  narration: "视觉质量门升级。事实卡、数据图、流程和结论都必须保持清晰可读。",
  scenes: [
    { type: "title", duration: 8, kicker: "QUALITY GATE", headline: "视觉质量门升级", subhead: "逐场景检查安全区、对比度、裁切和动画时机", sources: ["离线测试"] },
    { type: "briefing_points", duration: 8, headline: "确定性可读性检查", title: "页面结构", summary: "在录制前读取真实 DOM 布局与计算样式。", metrics: [{ label: "抽帧", value: "每屏三帧" }, { label: "审计", value: "逐元素" }], points: ["检查标题与正文安全区", "检查字号、行长和对比度", "检查遮挡、裁切与溢出"] },
    { type: "signal_chart", duration: 8, headline: "空白判断不再依赖文件大小", bars: [{ label: "亮度范围", value: 92, detail: "排除纯色画面" }, { label: "边缘密度", value: 78, detail: "识别真实视觉结构" }, { label: "DOM 状态", value: 86, detail: "确认关键节点可见" }] },
    { type: "flow", duration: 8, headline: "视觉检查进入渲染闭环", steps: [{ label: "DOM", detail: "录制前审计" }, { label: "Frame", detail: "每屏三点抽帧" }, { label: "OCR", detail: "可选关键文本识别" }, { label: "Repair", detail: "只重渲染问题场景" }] },
    { type: "outro", duration: 8, headline: "只修复真正有问题的场景", bullets: ["低置信度环境检查不误判内容", "布局错误切换模板并局部重渲染", "所有指标进入 run journal"] },
  ],
  sources: [{ id: "visual-fixture", kind: "webpage", title: "视觉质量测试", url: "https://example.com/visual", source: "fixture", summary: "视觉质量测试", content: "逐场景视觉质量门检查亮度、边缘、DOM 和 OCR。", score: 1, tags: [] }],
};

test("selected five-scene templates pass error-level DOM readability audit", { timeout: 120_000 }, async () => {
  const graph = buildHtmlVideoContentGraph(project);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: project.meta.width, height: project.meta.height } });
    for (const node of graph.nodes) {
      const template = getTemplateById(node.templateId);
      assert.ok(template);
      const scene = project.scenes[node.sceneIndex];
      await page.setContent(template.renderHtml({ project, scene, sceneIndex: node.sceneIndex, width: project.meta.width, height: project.meta.height, variantId: node.variantId }), { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const audit = await inspectSceneDom(page, { sceneIndex: node.sceneIndex, width: project.meta.width, height: project.meta.height, durationSec: scene.duration, headline: scene.headline, syncCues: node.syncCues });
      assert.deepEqual(audit.issues.filter((issue) => issue.severity === "error"), [], `scene=${node.sceneIndex} template=${node.templateId} ${JSON.stringify(audit.issues)}`);
    }
  } finally {
    await browser.close();
  }
});
