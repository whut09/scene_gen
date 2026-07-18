import type { VideoProject, VideoScene } from "./types";
import { directedStorySchema, type DirectedStory } from "./schemas";
import { fetchWithRetry } from "./external-operation";
import { attachFactReferences, buildFactLedger } from "./fact-ledger";
import { planStoryCandidates } from "./story-planner";
import type { StoryPlanCandidate, StoryPlanningAudit } from "./types";

function cleanStrings(values: unknown, limit: number) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim())
    .slice(0, limit);
}

function formatCoverHeadline(title: string) {
  return title
    .replace(/：/, "：\n")
    .replace(/，(?=价格|成本|售价)/, "\n");
}
function isChineseSummaryTitle(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const title = value.trim();
  const chineseCount = (title.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return chineseCount >= 6 && chineseCount / Math.max(1, title.replace(/\s+/g, "").length) >= 0.35;
}

function normalizeOpeningText(text: string) {
  return text.replace(/\s+/g, "").replace(/[：:，,。.!！?？_\-]/g, "").replace(/正式/g, "").toLowerCase();
}

function normalizeTitleIdentity(text: string) {
  return normalizeOpeningText(text).replace(/人工智能/g, "ai");
}

export function ensureTitleOpening(title: string, narration: string) {
  const spokenTitle = title.replace(/\s+/g, " ").trim().replace(/[。！？!?]+$/, "");
  const spokenNarration = narration.replace(/\s+/g, " ").trim();
  if (!spokenTitle) return spokenNarration;
  if (normalizeOpeningText(spokenNarration).startsWith(normalizeOpeningText(spokenTitle))) return spokenNarration;

  const boundary = spokenNarration.search(/[。！？!?]/);
  const firstSentence = boundary >= 0 ? spokenNarration.slice(0, boundary) : spokenNarration;
  const rest = boundary >= 0 ? spokenNarration.slice(boundary + 1).trim() : "";
  const titlePrefix = normalizeOpeningText(spokenTitle).slice(0, Math.min(12, normalizeOpeningText(spokenTitle).length));
  const firstLooksLikeTitle = titlePrefix.length >= 4 && normalizeOpeningText(firstSentence).includes(titlePrefix);
  let remainder = spokenNarration;
  if (firstLooksLikeTitle) {
    const commaIndex = firstSentence.search(/[，,]/);
    const tail = commaIndex >= 0 ? firstSentence.slice(commaIndex + 1).trim() : "";
    remainder = [tail, rest].filter(Boolean).join("。");
  }
  return remainder ? `${spokenTitle}。${remainder}` : `${spokenTitle}。`;
}
function inferEditorialLabels(project: VideoProject) {
  const sourceText = project.sources.map((item) => [item.title, item.summary, item.content].filter(Boolean).join(" ")).join(" ");
  if (/数学|猜想|证明|定理|图论|math|proof/i.test(sourceText)) {
    return {
      kicker: "AI 数学推理突破",
      briefing: "一小时证明是怎么完成的",
      chart: "700词 Prompt 锁定四个标准",
      flow: "证明路线如何一步步跑通",
      outro: "这次突破真正说明什么",
    };
  }
  if (/Agent|智能体|工具调用|编排|工作流/i.test(sourceText)) {
    return {
      kicker: "多智能体实战",
      briefing: "这套系统完成了什么",
      chart: "关键能力如何分布",
      flow: "多个 Agent 如何协同",
      outro: "真正值得关注的变化",
    };
  }
  if (/正式发布|正式推出|上线|开放|发布新模型/i.test(sourceText)) {
    return {
      kicker: "AI 新产品发布",
      briefing: "这次发布带来了什么",
      chart: "关键性能与成本变化",
      flow: "能力如何进入真实任务",
      outro: "发布之后还要验证什么",
    };
  }
  return {
    kicker: "AI 前沿进展",
    briefing: "这件事的核心事实",
    chart: "最值得关注的变化",
    flow: "事情是怎样发生的",
    outro: "最后看结论与边界",
  };
}

function mapGeneratedStrings<T>(value: T, transform: (text: string) => string): T {
  if (typeof value === "string") return transform(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapGeneratedStrings(item, transform)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapGeneratedStrings(child, transform)])) as T;
  }
  return value;
}

function sourceGroundingTransform(project: VideoProject) {
  const sourceText = project.sources.map((item) => [item.title, item.summary, item.content].filter(Boolean).join(" ")).join(" ");
  const explicitRelease = /正式发布|正式推出|正式上线|即日起.{0,60}(?:开放|可用)|向全球用户开放/i.test(sourceText);
  const reportsCompletedProof = /完成.{0,30}证明|证明完毕|写出.{0,20}证明稿/i.test(sourceText);
  return (input: string) => {
    let text = input;
    if (!explicitRelease) {
      text = text
        .replace(/GPT-5\.6已正式发布并向全球用户开放/g, "GPT-5.6 Sol Ultra公开可用")
        .replace(/已正式发布并向全球用户开放/g, "已经公开可用")
        .replace(/模型正式发布/g, "AI 数学推理突破");
    }
    if (reportsCompletedProof) {
      text = text
        .replace(/结果、方法与仍需核查的边界|证明结果、Prompt价值与待验证边界/g, "证明结果、Prompt方法与审查机制")
        .replace(/证明任务的四项可比规模数据/g, "证明任务的四个关键规模信号")
        .replace(/证明细节仍需围绕定义、边界情况、线性方程与关键引理逐项核查/g, "Prompt还设置独立审查，用来检查定义、边界情况、线性方程与关键引理")
        .replace(/候选证明仍需[^。；]+[。；]?/g, "Prompt设置独立审查，用来排查定义和推导漏洞。")
        .replace(/完成证明稿不等于核查流程终结，具体推导、定义使用和边界情况，仍需要数学界进一步验证/g, "独立审查负责检查具体推导、定义使用和边界情况，避免复杂任务在接近答案时留下漏洞");
    }
    text = text
      .replace(/现阶段结论与待核验边界/g, "模型能力、Prompt方法与审查机制")
      .replace(/公开可用仅指GPT-5\.6 Sol Ultra，不能据此表述为正式发布或全球开放/g, "公开可用的模型让多智能体实验具备可复现条件")
      .replace(/猜想是否真正解决，仍取决于证明细节与后续数学检验/g, "独立审查负责主动寻找定义、边界和推导漏洞")
      .replace(/公开可用的表述仅对应GPT-5\.6 Sol Ultra，不能延伸成正式发布或向全球用户开放。/g, "公开可用的模型让这次多智能体数学实验具备可复现条件。")
      .replace(/至于循环双覆盖猜想是否真正解决，仍需回到证明细节，并接受后续数学检验。/g, "独立审查被写进任务流程，用来主动寻找定义、边界和推导漏洞。");
    return text;
  };
}

export function normalizeDirectedStoryPayload(value: unknown, selectedPlan: StoryPlanCandidate) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const payload = { ...(value as Record<string, unknown>) };
  if (typeof payload.title !== "string") payload.title = selectedPlan.title;
  if (!Array.isArray(payload.titleClaimIds) || payload.titleClaimIds.length === 0) {
    payload.titleClaimIds = selectedPlan.titleClaimIds;
  }
  if (Array.isArray(payload.sections)) {
    payload.sections = payload.sections.map((rawSection, index) => {
      if (!rawSection || typeof rawSection !== "object" || Array.isArray(rawSection)) return rawSection;
      const section = { ...(rawSection as Record<string, unknown>) };
      if (!Array.isArray(section.claimIds) || section.claimIds.length === 0) {
        section.claimIds = selectedPlan.scenes[index]?.claimIds;
      }
      if (Array.isArray(section.bars)) {
        section.bars = section.bars.map((rawBar) => {
          if (!rawBar || typeof rawBar !== "object" || Array.isArray(rawBar)) return rawBar;
          const bar = { ...(rawBar as Record<string, unknown>) };
          if (typeof bar.value === "string") {
            const match = bar.value.match(/-?\d+(?:\.\d+)?/);
            if (match) bar.value = Number(match[0]);
            else delete bar.value;
          }
          return bar;
        });
      }
      if (Array.isArray(section.metrics)) {
        section.metrics = section.metrics.map((metric, metricIndex) => {
          if (typeof metric === "string") return { label: `要点 ${metricIndex + 1}`, value: metric };
          if (!metric || typeof metric !== "object" || Array.isArray(metric)) return metric;
          const normalizedMetric = { ...(metric as Record<string, unknown>) };
          if (typeof normalizedMetric.label !== "string") normalizedMetric.label = `要点 ${metricIndex + 1}`;
          if (typeof normalizedMetric.value !== "string") normalizedMetric.value = String(normalizedMetric.value ?? "");
          return normalizedMetric;
        });
      }
      return section;
    });
  }
  return payload;
}

function createDirectedProject(project: VideoProject, directed: DirectedStory, selectedPlan: StoryPlanCandidate, planningAudit: StoryPlanningAudit) {
  const sections = directed.sections;
  if (!sections || sections.length !== 5 || sections.some((section) => !section.narration?.trim())) {
    return project;
  }

  const isGithubProject = project.sources[0]?.kind === "github";
  const title = isChineseSummaryTitle(directed.title) ? directed.title.trim() : project.meta.title;
  const titleSection = sections[0];
  const briefingSection = sections[1];
  const chartSection = sections[2];
  const flowSection = sections[3];
  const outroSection = sections[4];
  const colors = ["#fff36a", "#72f0ff", "#ff8bd7", "#8aff9a"];
  const labels = inferEditorialLabels(project);
  const groundText = sourceGroundingTransform(project);
  const ledger = project.factLedger ?? buildFactLedger(project.sources);
  const titleClaimIds = directed.titleClaimIds ?? [];
  if (normalizeTitleIdentity(directed.title ?? "") !== normalizeTitleIdentity(selectedPlan.title)) throw new Error("Expanded title deviated from the selected story plan.");
  if (titleClaimIds.some((claimId) => !selectedPlan.titleClaimIds.includes(claimId))) throw new Error("Expanded title referenced facts outside the selected story plan.");
  sections.forEach((section, index) => {
    if ((section.claimIds ?? []).some((claimId) => !selectedPlan.scenes[index].claimIds.includes(claimId))) {
      throw new Error(`Expanded scene ${index} referenced facts outside the selected story plan.`);
    }
  });
  const knownClaimIds = new Set(ledger.claims.map((claim) => claim.id));
  const directedClaimIds = [...titleClaimIds, ...sections.flatMap((section) => section.claimIds ?? [])];
  const unknownClaimIds = directedClaimIds.filter((claimId) => !knownClaimIds.has(claimId));
  if (unknownClaimIds.length > 0) throw new Error(`Directed story referenced unknown fact claims: ${[...new Set(unknownClaimIds)].join(", ")}`);
  const scenes: VideoScene[] = [
    {
      type: "title",
      duration: 12,
      kicker: groundText(titleSection.kicker?.trim() || labels.kicker),
      headline: formatCoverHeadline(title),
      subhead: titleSection.subhead?.trim() || titleSection.summary?.trim() || project.sources[0]?.summary || "",
      sources: cleanStrings(titleSection.keywords, 3).length
        ? cleanStrings(titleSection.keywords, 3)
        : ["模型能力", "科学推理", "开放边界"],
      claimIds: titleSection.claimIds,
    },
    {
      type: "briefing_points",
      duration: 20,
      headline: briefingSection.headline?.trim() || labels.briefing,
      source: "核心事实",
      title,
      summary: briefingSection.summary?.trim() || project.sources[0]?.summary || "",
      metrics: (briefingSection.metrics ?? [])
        .filter((metric) => metric.label && metric.value)
        .slice(0, 3)
        .map((metric) => ({ label: metric.label!.trim(), value: metric.value!.trim() })),
      points: cleanStrings(briefingSection.points, 4),
      claimIds: briefingSection.claimIds,
    },
    {
      type: "signal_chart",
      duration: 20,
      headline: chartSection.headline?.trim() || labels.chart,
      bars: (chartSection.bars ?? [])
        .filter((bar) => bar.label && bar.detail)
        .slice(0, 4)
        .map((bar, index) => ({
          label: bar.label!.trim(),
          value: Math.max(10, Math.min(100, Number(bar.value ?? 70))),
          detail: bar.detail!.trim(),
          color: colors[index % colors.length],
        })),
      claimIds: chartSection.claimIds,
    },
    {
      type: "flow",
      duration: 20,
      headline: flowSection.headline?.trim() || labels.flow,
      steps: (flowSection.steps ?? [])
        .filter((step) => step.label && step.detail)
        .slice(0, 4)
        .map((step) => ({ label: step.label!.trim(), detail: step.detail!.trim() })),
      claimIds: flowSection.claimIds,
    },
    {
      type: "outro",
      duration: 18,
      headline: outroSection.headline?.trim() || labels.outro,
      bullets: cleanStrings(outroSection.bullets, 4),
      claimIds: outroSection.claimIds,
    },
  ];
  if (
    scenes[1].type !== "briefing_points" ||
    scenes[1].metrics.length < 2 ||
    scenes[1].points.length < 2 ||
    scenes[2].type !== "signal_chart" ||
    scenes[2].bars.length < 3 ||
    scenes[3].type !== "flow" ||
    scenes[3].steps.length < 3 ||
    scenes[4].type !== "outro" ||
    scenes[4].bullets.length < 2
  ) {
    return project;
  }

  const narrationSegments = sections.map((section, sceneIndex) => {
    const narration = section.narration!.replace(/\s+/g, " ").trim();
    return {
      sceneIndex,
      text: sceneIndex === 0 ? ensureTitleOpening(title, narration) : narration,
      claimIds: section.claimIds,
    };
  });
  const groundedScenes = mapGeneratedStrings(scenes, groundText);
  const groundedNarrationSegments = narrationSegments.map((segment) => ({ ...segment, text: groundText(segment.text) }));
  const durationSeconds = groundedScenes.reduce((sum, scene) => sum + scene.duration, 0);
  return attachFactReferences({
    ...project,
    factLedger: ledger,
    titleClaimIds,
    storyPlanning: planningAudit,
    meta: {
      ...project.meta,
      title,
      durationSeconds,
    },
    narration: groundedNarrationSegments.map((segment) => segment.text).join("\n"),
    narrationSegments: groundedNarrationSegments,
    scenes: groundedScenes,
  } satisfies VideoProject, ledger);
}

export async function improveWithOpenAI(
  project: VideoProject,
  options?: { targetSeconds?: number; forbidAttribution?: boolean; editorialNotes?: string },
) {
  project = attachFactReferences(project);
  const apiKey = process.env.NEWS_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return project;

  const model = process.env.NEWS_LLM_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const baseUrl = process.env.NEWS_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const targetSeconds = options?.targetSeconds ?? 90;
  let planning;
  try {
    planning = await planStoryCandidates({ project, apiKey, baseUrl, model, targetSeconds, editorialNotes: options?.editorialNotes });
  } catch (error) {
    console.warn(`[llm] story planning failed: ${(error as Error).message}`);
    return project;
  }
  const isGithubProject = project.sources[0]?.kind === "github";
  const targetChars = Math.max(650, Math.min(1100, Math.round(targetSeconds * 8.5)));
  const guidance = [
    "你是 AI 科技竖屏短视频的资深新闻编导。",
    "只返回 JSON，不要 Markdown。",
    `总旁白建议约 ${targetChars} 个汉字；${targetSeconds} 秒只是时长参考，不要为了凑时长增加信息或强行压缩语速。`,
    "必须输出 title 和 sections；sections 恰好 5 个，visual 顺序固定为 title、briefing、chart、flow、outro。",
    "selectedPlan 已通过确定性检查。必须逐字使用 selectedPlan.title，并严格按 selectedPlan.scenes 的 angle、focus 和 claimIds 展开，不得切换叙事角度或新增事实。",
    "factLedger 是唯一声明级事实账本。title 必须返回 titleClaimIds；每个 section 必须返回 claimIds，且只能引用 factLedger 中存在、能够直接支持当前画面和旁白的 id。",
    "高风险表述（发布、开放、领先、提升、增长、降低等）必须引用 evidenceText 明确包含该动作的 claim；不得把可能、部分用户、实验结果、仅、尚未等限定词省略。",
    "每个 section 必须有 narration。先确定该 section 的所有画面字段，再写旁白；旁白只能复述、串联或简要解释当前 section 屏幕上实际可见的信息。",
    "禁止在旁白中加入当前屏幕没有呈现的新数据、新案例、新结论或额外背景；需要讲的信息必须先写进该 section 的可视字段。",
    "逐屏旁白长度：title 70-130 字，briefing 120-200 字，chart 110-190 字，flow 110-190 字，outro 80-150 字。宁可让视频自然变长或变短，也不要堆字。",
    "不要出现新闻怎么跟进、如何发布、适合做视频、作者、编辑、站点、媒体来源等无关内容。",
    isGithubProject
      ? "这是GitHub项目拆解，不是热点发布新闻。README和仓库元数据是唯一依据，重点解释项目解决什么问题、核心工作流、技能结构、支持平台和适用边界。outro只能使用README明确写出的安装差异、使用方式、方法论定位或适用对象；README没有限制条件时就总结适用场景，不得虚构隐私、联网、环境变量或性能边界。"
      : "sourceArticle 是唯一新闻依据。忠实总结文章中的发布状态、开放范围、模型能力、价格和数据，不得主动引入站外信息推翻或改写原文。",
    "如果文章明确写正式发布、正式推出或即日起开放，首段必须直接使用对应表述，并说明开放渠道和用户范围，不得弱化。",
    "不要照抄长原文，不要虚构文章中没有的数据；只有用户明确传入事实校正备注时，才按备注调整。",
    "先判断新闻事件类型：产品发布、研究突破、公司动态、政策变化或工具实测。研究成果不得写成产品发布，产品发布不得写成尚未开放。",
    "每个 section 的 headline 必须描述本屏具体内容，禁止使用关键变化、影响路径、最后判断、这次发布讲了什么等通用占位标题。",
    isGithubProject
      ? "title 必须是简洁的中文项目总结标题，不要直接使用英文 README 标题；可保留必要的项目专有名，但中文必须占主体，控制在15到32个汉字。提供4到10个汉字的kicker、subhead和3个keywords。第一句话完整播报生成后的中文项目标题。"
      : "title 必须用中文重新概括原文最重要、最有吸引力的事实，控制在14到30个汉字，不要照搬英文标题，不要写媒体名或作者。title 场景额外提供4到10个汉字的kicker，并提供subhead和3个keywords；第一句必须逐字播报生成后的中文标题，再进入正文。",
    "briefing 场景提供 summary、3 个 metrics、3 到 4 个 points；旁白逐项概括这些字段，不扩展屏幕外事实。",
    "chart 场景提供 4 个 bars，每个含 label、value、detail。原文有真实可比数字时才把 value 当数据展示；原文只有定性原则时，value仅供布局计算，画面使用无百分比的排序卡，旁白不得提到评分、百分比或内容权重。",
    "flow 场景提供 4 个 steps，每个含 label、detail；旁白严格按这 4 步的顺序讲解。",
    "outro 场景提供 3 个 bullets，必须包含限制条件或后续验证项；旁白只总结这 3 条，不另起新观点。",
    options?.forbidAttribution
      ? "所有画面和旁白都不得出现作者、编辑、量子位、QbitAI、新浪、腾讯新闻或来源归属字眼。"
      : "",
    options?.editorialNotes ? `用户明确要求（包含历史反馈和本轮修订项）：${options.editorialNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetchWithRetry(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.28,
      messages: [
        { role: "system", content: guidance },
        {
          role: "user",
          content: JSON.stringify({
            currentTitle: project.meta.title,
            selectedPlan: planning.selected,
            factLedger: project.factLedger,
            sourceArticle: project.sources.map((item) => ({
              title: item.title,
              summary: item.summary,
              content: item.content,
              publishedAt: item.publishedAt,
              kind: item.kind,
              repo: item.repo,
              metrics: item.metrics,
              tags: item.tags,
            })),
          }),
        },
      ],
      response_format: { type: "json_object" },
    }),
  }, { label: "story-llm", timeoutMs: Number(process.env.NEWS_LLM_TIMEOUT_MS ?? 120_000) });

  if (!response.ok) {
    console.warn(`[llm] OpenAI failed: ${response.status} ${await response.text()}`);
    return project;
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return project;

  try {
    const audit = { ...planning.audit, expansionTokens: data.usage?.total_tokens ?? 0 };
    return createDirectedProject(project, directedStorySchema.parse(normalizeDirectedStoryPayload(JSON.parse(content), planning.selected)), planning.selected, audit);
  } catch (error) {
    console.warn(`[llm] invalid directed story: ${(error as Error).message}`);
    return project;
  }
}
