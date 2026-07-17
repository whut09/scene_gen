import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { z } from "zod";
import type { SyncCue } from "../production/types";
import { issueCodeSchema, type IssueCode } from "../harness/issue-registry";

export const visualAuditIssueSchema = z.object({
  code: issueCodeSchema,
  severity: z.enum(["warning", "error"]),
  message: z.string().min(1),
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}),
});

export const sceneVisualAuditSchema = z.object({
  sceneIndex: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSec: z.number().positive(),
  checkedAt: z.string().datetime(),
  elementCount: z.number().int().nonnegative(),
  keyTextCount: z.number().int().nonnegative(),
  maximumAnimationEndMs: z.number().nonnegative(),
  issues: z.array(visualAuditIssueSchema),
});

export const visualAuditFileSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime(),
  scenes: z.array(sceneVisualAuditSchema),
});

export type SceneVisualAudit = z.infer<typeof sceneVisualAuditSchema>;
export type VisualAuditFile = z.infer<typeof visualAuditFileSchema>;

export async function inspectSceneDom(page: Page, input: {
  sceneIndex: number;
  width: number;
  height: number;
  durationSec: number;
  headline: string;
  syncCues?: SyncCue[];
}) {
  await page.addScriptTag({ content: "globalThis.__name ||= ((target) => target);" });
  const audit = await page.evaluate(async ({ width, height, durationSec, headline, syncCues }) => {
    type BrowserIssue = { code: IssueCode; severity: "warning" | "error"; message: string; evidence: Record<string, string | number | boolean | string[]> };
    const issues: BrowserIssue[] = [];
    const normalize = (value: string) => value.toLowerCase().replace(/\s+|[^a-z0-9\u4e00-\u9fff]/g, "");
    const animations = document.getAnimations();
    const animationRecords = animations.map((animation) => {
      const timing = animation.effect?.getComputedTiming();
      const configured = animation.effect?.getTiming();
      const configuredDuration = typeof configured?.duration === "number" ? configured.duration : 0;
      const iterations = typeof configured?.iterations === "number" ? configured.iterations : 1;
      return {
        id: animation.id,
        target: animation.effect instanceof KeyframeEffect && animation.effect.target instanceof Element ? animation.effect.target : null,
        endTimeMs: typeof timing?.endTime === "number" && Number.isFinite(timing.endTime) ? timing.endTime : 0,
        reveal: !animation.id.startsWith("sg-sync-emphasis-") && iterations <= 1 && configuredDuration > 0 && configuredDuration <= Math.min(2500, durationSec * 400),
      };
    });
    for (const animation of animations) {
      try { animation.finish(); } catch { /* finite CSS animations only */ }
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const parseColor = (value: string) => {
      const match = value.match(/rgba?\((\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)(?:[, /]+(\d+(?:\.\d+)?))?\)/i);
      return match ? { red: Number(match[1]), green: Number(match[2]), blue: Number(match[3]), alpha: match[4] === undefined ? 1 : Number(match[4]) } : null;
    };
    const luminance = (color: { red: number; green: number; blue: number }) => {
      const values = [color.red, color.green, color.blue].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    const contrastRatio = (foreground: { red: number; green: number; blue: number }, background: { red: number; green: number; blue: number }) => {
      const bright = Math.max(luminance(foreground), luminance(background));
      const dark = Math.min(luminance(foreground), luminance(background));
      return (bright + 0.05) / (dark + 0.05);
    };
    const effectiveBackground = (element: Element) => {
      let current: Element | null = element;
      while (current) {
        const style = getComputedStyle(current);
        if (style.backgroundImage !== "none") return null;
        const parsed = parseColor(style.backgroundColor);
        if (parsed && parsed.alpha >= 0.95) return parsed;
        current = current.parentElement;
      }
      return parseColor(getComputedStyle(document.body).backgroundColor);
    };
    const visibleTextElements = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => {
      if (element.closest('[aria-hidden="true"]')) return false;
      const ownText = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join(" ").trim();
      if (!ownText) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.02 && rect.width > 1 && rect.height > 1;
    });
    const safeX = width * Number((window as unknown as { __SG_SAFE_X?: number }).__SG_SAFE_X ?? 0.045);
    const safeTop = height * 0.04;
    const safeBottom = height * 0.035;
    const elementRecords = visibleTextElements.map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const text = (element.innerText || element.textContent || "").trim();
      const className = typeof element.className === "string" ? element.className : "";
      const primary = /^H[1-3]$/.test(element.tagName) || /headline|title|metric|value|step|bullet/i.test(className) || element.hasAttribute("data-sg-key");
      const fontSize = Number.parseFloat(style.fontSize) || 0;
      const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.2;
      const lines = Math.max(1, Math.round(rect.height / Math.max(1, lineHeight)));
      const charsPerLine = [...normalize(text)].length / lines;
      const outside = rect.left < -1 || rect.top < -1 || rect.right > width + 1 || rect.bottom > height + 1;
      if (outside) issues.push({ code: "dom_element_out_of_bounds", severity: "error", message: `文本元素超出画布：${text.slice(0, 40)}`, evidence: { text: text.slice(0, 80), left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) } });
      if (primary && (rect.left < safeX || rect.right > width - safeX || rect.top < safeTop || rect.bottom > height - safeBottom)) {
        issues.push({ code: "text_unsafe_zone", severity: "error", message: `关键文本进入竖屏安全区外：${text.slice(0, 40)}`, evidence: { text: text.slice(0, 80), fontSize, left: Math.round(rect.left), top: Math.round(rect.top) } });
      }
      const minimumFont = primary ? 24 : 16;
      if (fontSize < minimumFont) issues.push({ code: "text_too_small", severity: primary ? "error" : "warning", message: `文本字号 ${fontSize.toFixed(1)}px 低于 ${minimumFont}px：${text.slice(0, 40)}`, evidence: { text: text.slice(0, 80), fontSize, minimumFont } });
      if (charsPerLine > (primary ? 28 : 36)) issues.push({ code: "text_line_too_long", severity: "warning", message: `单行文字过长：${text.slice(0, 40)}`, evidence: { text: text.slice(0, 80), charsPerLine: Number(charsPerLine.toFixed(1)), lines } });
      const horizontalOverflow = element.scrollWidth - element.clientWidth;
      const verticalOverflow = element.scrollHeight - element.clientHeight;
      if (horizontalOverflow > Math.max(4, fontSize * 0.15) || verticalOverflow > Math.max(4, fontSize * 0.2)) issues.push({ code: "content_clipped", severity: "error", message: `文本存在裁切或溢出：${text.slice(0, 40)}`, evidence: { text: text.slice(0, 80), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight } });
      const foreground = parseColor(style.color);
      const background = effectiveBackground(element);
      if (foreground && background) {
        const ratio = contrastRatio(foreground, background);
        const minimumRatio = fontSize >= 28 || Number(style.fontWeight) >= 700 ? 3 : 4.5;
        if (ratio < minimumRatio) issues.push({ code: "text_contrast_low", severity: "error", message: `文本对比度 ${ratio.toFixed(2)} 低于 ${minimumRatio}：${text.slice(0, 40)}`, evidence: { text: text.slice(0, 80), contrastRatio: Number(ratio.toFixed(2)), minimumRatio } });
      }
      return { element, rect, text, primary };
    });

    for (let leftIndex = 0; leftIndex < elementRecords.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < elementRecords.length; rightIndex += 1) {
        const left = elementRecords[leftIndex];
        const right = elementRecords[rightIndex];
        if (left.element.contains(right.element) || right.element.contains(left.element)) continue;
        const overlapWidth = Math.max(0, Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left));
        const overlapHeight = Math.max(0, Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top));
        const overlap = overlapWidth * overlapHeight;
        const smaller = Math.min(left.rect.width * left.rect.height, right.rect.width * right.rect.height);
        if (smaller > 0 && overlap / smaller > 0.35) issues.push({ code: "element_overlap", severity: "warning", message: `文本元素明显遮挡：${left.text.slice(0, 24)} / ${right.text.slice(0, 24)}`, evidence: { texts: [left.text.slice(0, 60), right.text.slice(0, 60)], overlapRatio: Number((overlap / smaller).toFixed(2)) } });
      }
    }

    const bodyText = normalize(document.body.innerText);
    const keyTexts = [headline, ...syncCues.map((cue) => cue.text)].map((text) => text.trim()).filter(Boolean);
    for (const keyText of keyTexts) {
      const normalized = normalize(keyText);
      if (normalized.length >= 2 && !bodyText.includes(normalized)) issues.push({ code: "key_text_not_visible", severity: "error", message: `关键文本未出现在 DOM：${keyText}`, evidence: { keyText } });
    }
    for (const cue of syncCues) {
      const normalizedCue = normalize(cue.text);
      const target = elementRecords.filter((record) => normalize(record.text).includes(normalizedCue)).sort((left, right) => left.text.length - right.text.length)[0]?.element;
      if (!target) continue;
      const revealEndMs = Math.max(...animationRecords.filter((record) => record.reveal && record.target && (target.contains(record.target) || record.target.contains(target))).map((record) => record.endTimeMs), 0);
      const expectedMs = cue.startRatio * durationSec * 1000;
      if (revealEndMs > expectedMs + 500) issues.push({ code: "sync_cue_visual_late", severity: "warning", message: `关键词“${cue.text}”出现晚于旁白提示。`, evidence: { keyText: cue.text, revealEndMs: Math.round(revealEndMs), expectedMs: Math.round(expectedMs) } });
    }

    const maximumAnimationEndMs = Math.max(...animationRecords.filter((record) => record.reveal && record.target && normalize(record.target.textContent ?? "").length > 0).map((record) => record.endTimeMs), 0);
    const minimumHoldMs = Number((window as unknown as { __SG_CONCLUSION_HOLD_MS?: number }).__SG_CONCLUSION_HOLD_MS ?? 800);
    if (maximumAnimationEndMs > durationSec * 1000 - minimumHoldMs) issues.push({ code: "conclusion_hold_too_short", severity: "warning", message: "动画结束后关键结论停留时间不足。", evidence: { maximumAnimationEndMs: Math.round(maximumAnimationEndMs), durationMs: Math.round(durationSec * 1000), minimumHoldMs } });

    for (const image of document.querySelectorAll<HTMLImageElement>("img")) {
      const style = getComputedStyle(image);
      const rect = image.getBoundingClientRect();
      if (style.objectFit === "cover" && image.naturalWidth > image.naturalHeight && rect.height > rect.width * 1.3 && !image.dataset.focalPoint && style.objectPosition === "50% 50%") {
        issues.push({ code: "image_subject_crop_risk", severity: "warning", message: "横向图片在竖屏 cover 裁切中未声明主体焦点。", evidence: { src: (image.currentSrc || image.src).slice(0, 200), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, objectPosition: style.objectPosition } });
      }
    }
    return { elementCount: elementRecords.length, keyTextCount: keyTexts.length, maximumAnimationEndMs, issues };
  }, { width: input.width, height: input.height, durationSec: input.durationSec, headline: input.headline, syncCues: input.syncCues ?? [] });

  return sceneVisualAuditSchema.parse({
    sceneIndex: input.sceneIndex,
    width: input.width,
    height: input.height,
    durationSec: input.durationSec,
    checkedAt: new Date().toISOString(),
    ...audit,
  });
}

export async function readVisualAuditFile(filePath: string) {
  return visualAuditFileSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}
