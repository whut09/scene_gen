import { createHash } from "node:crypto";
import type { FactClaim, FactLedger, HotItem, NarrationSegment, VideoProject, VideoScene } from "./types";

const risky = ["正式发布", "发布", "正式推出", "开放", "上线", "领先", "提升", "增长", "降低", "减少", "增加", "支持", "仅限", "计划"];
const qualifiers = [/部分(?:用户|地区|场景|功能)?/g, /可能|预计|有望|或将|计划|拟/g, /实验结果|测试结果|初步结果|内部测试|基准测试/g, /仅|只|最多|至少|不超过|约|近|超过/g, /尚未|暂未|仍需|取决于/g, /截至[^，。；]{1,24}/g];

function normalize(value: string) {
  return value.replace(/\s+/g, "").replace(/[，。！？；：、,.!?;:'"“”‘’（）()【】\[\]<>《》]/g, "").toLowerCase();
}

function claimId(sourceId: string, predicate: string, value: string) {
  return `fact-${createHash("sha256").update(JSON.stringify({ sourceId, predicate, value })).digest("hex").slice(0, 20)}`;
}

export function qualifiersInText(text: string) {
  return [...new Set(qualifiers.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0])))];
}

export function highRiskPredicatesInText(text: string) {
  return risky.filter((predicate) => text.includes(predicate));
}

function sentenceClaim(source: HotItem, text: string, confidence: number, fromContent: boolean): FactClaim {
  const predicate = risky.find((item) => text.includes(item)) ?? "陈述";
  const evidenceStart = fromContent ? source.content?.indexOf(text) : undefined;
  return {
    id: claimId(source.id, predicate, text), subject: source.repo ?? source.title, predicate, value: text,
    qualifiers: qualifiersInText(text), sourceId: source.id, evidenceText: text,
    ...(typeof evidenceStart === "number" && evidenceStart >= 0 ? { evidenceStart, evidenceEnd: evidenceStart + text.length } : {}), confidence,
  };
}

export function buildFactLedger(sources: HotItem[]): FactLedger {
  const claims = new Map<string, FactClaim>();
  for (const source of sources) {
    for (const [value, fromContent] of [[source.title, false], [source.summary, false], [source.content ?? "", true]] as const) {
      for (const match of value.matchAll(/[^。！？!?\n]+[。！？!?]?/g)) {
        const text = match[0].trim();
        if (text.length < 4) continue;
        const claim = sentenceClaim(source, text, fromContent ? 0.9 : 0.82, fromContent);
        claims.set(claim.id, claim);
      }
    }
    for (const [key, rawValue] of Object.entries(source.metrics ?? {})) {
      const value = String(rawValue);
      const predicate = `指标:${key.trim()}`;
      const claim: FactClaim = {
        id: claimId(source.id, predicate, value), subject: source.repo ?? source.title, predicate, value,
        qualifiers: qualifiersInText(value), sourceId: source.id, evidenceText: `${key}：${value}`, confidence: 0.98,
      };
      claims.set(claim.id, claim);
    }
  }
  return { version: 1, claims: [...claims.values()] };
}

function tokens(value: string) {
  const result = new Set<string>();
  for (const match of normalize(value).matchAll(/[a-z][a-z0-9.+-]+|\d+(?:\.\d+)?%?|[\u4e00-\u9fff]{2,}/gi)) {
    const token = match[0];
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length > 3) {
      for (let index = 0; index < token.length - 1; index += 2) result.add(token.slice(index, index + 2));
    } else result.add(token);
  }
  return result;
}

export function claimIdsForText(ledger: FactLedger, text: string, limit = 8) {
  const textTokens = tokens(text);
  const numbers = new Set(text.match(/\d+(?:\.\d+)?%?/g) ?? []);
  return ledger.claims.map((claim) => {
    const claimTokens = tokens(`${claim.subject} ${claim.predicate} ${claim.evidenceText}`);
    const overlap = [...textTokens].filter((token) => claimTokens.has(token)).length;
    const numberMatches = [...numbers].filter((number) => claim.evidenceText.includes(number)).length;
    const predicateMatches = highRiskPredicatesInText(text).filter((predicate) => claim.evidenceText.includes(predicate)).length;
    return { id: claim.id, score: overlap + numberMatches * 4 + predicateMatches * 3 };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit).map((item) => item.id);
}

export function sceneFactText(scene: VideoScene) {
  switch (scene.type) {
    case "title": return [scene.kicker, scene.headline, scene.subhead, ...scene.sources].join(" ");
    case "briefing_points": return [scene.headline, scene.title, scene.summary, ...scene.metrics.flatMap((item) => [item.label, item.value]), ...scene.points].join(" ");
    case "signal_chart": return [scene.headline, ...scene.bars.flatMap((item) => [item.label, item.detail])].join(" ");
    case "flow": return [scene.headline, ...scene.steps.flatMap((item) => [item.label, item.detail])].join(" ");
    case "outro": return [scene.headline, ...scene.bullets].join(" ");
    case "news_stack": return [scene.headline, ...scene.items.flatMap((item) => [item.title, item.summary])].join(" ");
    case "web_screenshot_zoom": return [scene.headline, ...scene.shots.map((item) => item.title)].join(" ");
    case "timeline": return [scene.headline, ...scene.events.flatMap((item) => [item.date, item.title])].join(" ");
    case "github_pulse": return [scene.headline, ...scene.repos.flatMap((item) => [item.repo, item.title, item.summary])].join(" ");
  }
}

function validIds(ledger: FactLedger, claimIds: string[] | undefined) {
  const known = new Set(ledger.claims.map((claim) => claim.id));
  return [...new Set((claimIds ?? []).filter((claimId) => known.has(claimId)))];
}

export function attachFactReferences(project: VideoProject, ledger = project.factLedger ?? buildFactLedger(project.sources)): VideoProject {
  const scenes = project.scenes.map((scene) => {
    const explicit = validIds(ledger, scene.claimIds);
    return { ...scene, claimIds: explicit.length ? explicit : claimIdsForText(ledger, sceneFactText(scene)) };
  }) as VideoScene[];
  const narrationSegments = project.narrationSegments?.map((segment, index): NarrationSegment => {
    const explicit = validIds(ledger, segment.claimIds);
    return { ...segment, claimIds: explicit.length ? explicit : claimIdsForText(ledger, `${sceneFactText(scenes[index])} ${segment.text}`) };
  });
  const titleClaims = validIds(ledger, project.titleClaimIds);
  return { ...project, factLedger: ledger, titleClaimIds: titleClaims.length ? titleClaims : claimIdsForText(ledger, project.meta.title), scenes, narrationSegments };
}

export function referencedClaims(project: VideoProject, claimIds: string[] | undefined) {
  const selected = new Set(claimIds ?? []);
  return (project.factLedger?.claims ?? []).filter((claim) => selected.has(claim.id));
}

export function findFactConflicts(ledger: FactLedger) {
  const groups = new Map<string, FactClaim[]>();
  for (const claim of ledger.claims.filter((item) => item.predicate.startsWith("指标:"))) {
    const key = `${normalize(claim.subject)}:${normalize(claim.predicate)}`;
    groups.set(key, [...(groups.get(key) ?? []), claim]);
  }
  return [...groups.values()].filter((claims) => new Set(claims.map((claim) => normalize(claim.value))).size > 1);
}
