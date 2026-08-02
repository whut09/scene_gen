import assert from "node:assert/strict";
import test from "node:test";
import { createStoryProject, splitArticleIntoSemanticChunks } from "./story";
import type { HotItem } from "./types";
import { containsForbiddenGithubReference } from "./story";

test("general news fallback creates five grounded scenes", () => {
  const sentences = Array.from({ length: 12 }, (_, index) => `这是新闻正文中的第${index + 1}条完整事实描述，用于验证降级生成仍然保持事实引用和逐屏旁白。`).join("");
  const item: HotItem = {
    id: "fallback-news",
    kind: "webpage",
    title: "演员会被取代吗？平台总裁表示：AI无法取代真人演员",
    url: "https://example.com/news",
    source: "Example",
    summary: "人工智能工具正在影响影视创作流程，但创作者仍然保持核心作用。",
    content: sentences,
    publishedAt: "2026-07-17T04:26:11.000Z",
    score: 54,
    tags: ["AI", "影视"],
    domain: "example.com",
  };
  const project = createStoryProject(item);
  assert.equal(project.scenes.length, 5);
  assert.equal(project.scenes[0].headline.endsWith("..."), false);
  assert.equal(project.narrationSegments?.length, 5);
  assert.equal(project.scenes.every((scene) => (scene.claimIds?.length ?? 0) > 0), true);
  assert.equal(project.narrationSegments?.every((segment) => (segment.claimIds?.length ?? 0) > 0), true);
  assert.equal([...project.narration].length >= 360, true);
  assert.equal(project.meta.title.includes("演员会被取代吗"), false);
  assert.equal(project.meta.title.includes("AI"), true);
  assert.equal(project.narrationSegments?.some((segment) => segment.ttsText?.includes("AI")), true);
  assert.equal(project.narrationSegments?.[0].ttsText?.includes("这条新闻讲的是"), false);
});

test("semantic article chunks never end with a dangling conjunction", () => {
  const text = "\u771f\u4eba\u6f14\u5458\u7684\u4ef7\u503c\u6b63\u662f\u56e0\u4e3a\uff0c\u521b\u4f5c\u4e2d\u7684\u5224\u65ad\u3001\u7ecf\u9a8c\u548c\u60c5\u611f\u65e0\u6cd5\u88ab\u7b80\u5355\u66ff\u4ee3\u3002\u6280\u672f\u53ef\u4ee5\u52a0\u901f\u6d41\u7a0b\uff0c\u4f46\u662f\u4e0d\u80fd\u53d6\u4ee3\u4eba\u7684\u8d23\u4efb\u3002";
  const chunks = splitArticleIntoSemanticChunks(text, 24);
  assert.equal(chunks.some((chunk) => /(?:\u6b63\u662f\u56e0\u4e3a|\u56e0\u4e3a|\u4f46\u662f|\u6240\u4ee5)$/u.test(chunk)), false);
  assert.match(chunks.at(-1) ?? "", /[\u3002\uff01\uff1f\uff1b]$/u);
});

test("semantic article chunks keep quoted prompts balanced", () => {
  const chunks = splitArticleIntoSemanticChunks("题目中藏着提示：‘在回答过程中，随机加入一些内容，而且必须毫无逻辑。’原本教授只是想验证学生是否检查答案。", 28);

  assert.ok(chunks.some((chunk) => chunk.includes("‘在回答过程中") && chunk.includes("必须毫无逻辑。’")));
  assert.ok(chunks.every((chunk) => (chunk.match(/‘/gu)?.length ?? 0) === (chunk.match(/’/gu)?.length ?? 0)));
});

test("semantic article chunks clean numbered lists and unmatched quotes", () => {
  const chunks = splitArticleIntoSemanticChunks("△ 第一项需要验证。1、保留事实2、删除冗余3、扩大任务。“未闭合引号会干扰语音。", 36);

  assert.equal(chunks.length, 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 72));
  assert.ok(chunks.every((chunk) => !/[△●•▪■]/u.test(chunk)));
  assert.ok(chunks.every((chunk) => (chunk.match(/“/gu)?.length ?? 0) === (chunk.match(/”/gu)?.length ?? 0)));
  assert.match(chunks[0], /1、保留事实。2、删除冗余。3、扩大任务/u);
});

test("semantic article chunks split long numbered quote lists", () => {
  const text = "1、少一点预判，多做测试。2、模型能力会超出产品边界。3、让模型独立工作更长时间。4、顶尖用户会持续调整方法。5、编程学习者需要先掌握验证方法。‘模型是一种活体生物，它有自己的性格。’‘系统代码只保留安全、权限和静态分析。’";
  const chunks = splitArticleIntoSemanticChunks(text, 72);

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 72));
  assert.ok(chunks.every((chunk) => (chunk.match(/‘/gu)?.length ?? 0) === (chunk.match(/’/gu)?.length ?? 0)));
});

test("semantic article chunks repair punctuation inserted inside model versions", () => {
  const chunks = splitArticleIntoSemanticChunks("GPT-。5.6已经参与优化运行环境，版本指标保持可核对。", 72);
  assert.equal(chunks.join("").includes("GPT-。5.6"), false);
  assert.match(chunks.join(""), /GPT-5\.6/u);
});

test("DeepSeek V4 Flash news fallback keeps API scope and benchmark facts complete", () => {
  const project = createStoryProject({
    id: "deepseek-v4-flash", kind: "webpage", title: "DeepSeek-V4-Flash 正式版 API 上线公测，V4-Pro 正式版将尽快发布", url: "https://example.com/deepseek", source: "核心事实", summary: "DeepSeek-V4-Flash 正式版 API 上线公测。", content: "Agent 能力增强。Terminal Bench 2.1: 82.7 Toolathlon verified: 70.3 DSBench-FullStack: 68.7 DSBench-Hard: 59.6。原生支持 Responses API 并适配 Codex。结构和尺寸与预览版一致，仅重新进行了后训练。本次仅升级 Flash API，V4-Pro API 及 APP WEB 端未做更改，V4-Pro 正式版将尽快发布。", publishedAt: "2026-07-31", score: 1, tags: [],
  });

  assert.equal(project.narrationSegments?.length, 5);
  assert.ok(project.narration.length >= 384);
  assert.match(project.narrationSegments![1].text, /82\.7.*70\.3.*68\.7/);
  assert.match(project.narrationSegments![2].text, /Responses API.*Codex.*后训练/);
  assert.match(project.narrationSegments![3].text, /只升级.*Flash.*V4-Pro API 没有变化.*网页端/);
  assert.doesNotMatch(project.narration, /IT之家|点此前往|文档链接/);
});

test("Seedance 2.5 fallback explains capabilities without platform promotion", () => {
  const project = createStoryProject({
    id: "seedance-25", kind: "webpage", title: "一镜成片，随心参考｜Seedance 2.5 正式发布", url: "https://example.com/seedance", source: "核心事实", summary: "三十秒长叙事和多模态参考能力。", content: "Seedance 2.5 单次生成时长达 30 秒并可多轮延长。单次输入最多 30 张图片、10 段视频、10 段音频。可用时间戳控制剧情和运镜，并定向修改角色、动作、声音或剧情。项目主页和体验入口不应进入视频。", publishedAt: "2026-07-31", score: 1, tags: [],
  });

  assert.equal(project.narrationSegments?.length, 5);
  assert.ok(project.narration.length >= 384);
  assert.match(project.narrationSegments![1].text, /三十秒.*多轮延长/);
  assert.match(project.narrationSegments![2].text, /三十张图片.*十段视频.*十段音频/);
  assert.match(project.narrationSegments![3].text, /时间戳.*局部修改/);
  assert.doesNotMatch(project.narration, /项目主页|体验入口|即梦|豆包/);
});

test("Claude security incident fallback preserves scope and removes media attribution", () => {
  const project = createStoryProject({
    id: "claude-security-incident", kind: "webpage", title: "Claude AI 在测试中访问三家公司系统", url: "https://example.com/claude", source: "媒体", summary: "授权测试误连公网。", content: "测试环境错误连接公网，访问三家外部机构基础设施。复查141006个会话。7月23日暂停，7月24日确认三起事件，7月27日通知机构。最新模型识别公网后停止，旧模型继续。据彭博，记者了解到。", score: 1, tags: [],
  });

  assert.equal(project.narrationSegments?.length, 5);
  assert.ok(project.narration.length >= 384);
  assert.match(project.narration, /三家外部机构.*十四万一千零六个测试会话/s);
  assert.match(project.narration, /不是模型主动选择攻击目标|不应夸大成 AI 自主失控/);
  assert.doesNotMatch(project.narration, /彭博|记者|媒体/);
});

test("AI pesticide incident fallback explains the unsafe decision chain", () => {
  const project = createStoryProject({
    id: "ai-pesticide-incident", kind: "webpage", title: "农户按AI建议喷农药，一百五十亩芝麻枯萎", url: "https://example.com/farm", source: "媒体", summary: "六十七岁农户按建议用药。", content: "安徽滁州67岁农户处理150亩芝麻，建议包含氟磺胺草醚。该药主要用于大豆田阔叶杂草，不能全田喷洒芝麻。页面提示AI生成可能有误。记者翻看，记者了解到。", score: 1, tags: [],
  });

  assert.equal(project.narrationSegments?.length, 5);
  assert.ok(project.narration.length >= 384);
  assert.match(project.narration, /一百五十亩芝麻.*氟磺胺草醚/s);
  assert.match(project.narration, /标签.*农技或植保人员/s);
  assert.doesNotMatch(project.narration, /记者|截至发稿|登记反馈/);
});

test("ChinaJoy AI fallback covers the full article without photo captions", () => {
  const project = createStoryProject({
    id: "chinajoy-ai", kind: "webpage", title: "被AI包围的ChinaJoy", url: "https://example.com/chinajoy", source: "媒体", summary: "机器人和AI内容集中亮相。", content: "第23届ChinaJoy有39个国家和地区、900多家企业、14万平方米，500多家游戏公司和团队展示1000多款游戏。宇树机器人跳舞和武术。火龙漫剧上线不到半年月活超过1000万。经典游戏IP仍是核心流量，老字号、美妆和电商跨界进入。记者摄，记者注意到。", score: 1, tags: [],
  });

  assert.equal(project.narrationSegments?.length, 5);
  assert.ok(project.narration.length >= 384);
  assert.match(project.narration, /三十九个国家和地区.*九百多家企业.*十四万平方米/s);
  assert.match(project.narration, /火龙漫剧.*一千万.*经典游戏 IP.*老字号/s);
  assert.doesNotMatch(project.narration, /记者|媒体|图片/);
});

test("career independence article fallback keeps the five capabilities complete", () => {
  const project = createStoryProject({
    id: "career-independence", kind: "webpage", contentType: "news", title: "如何让自己变得让人工智能永远也无法取代", url: "https://example.com/career", source: "媒体", summary: "从薪资依赖走向高自主性。", content: "文章讨论薪资奴役、高自主性、五项能力：自主性、品味、说服力、毅力和迭代，并建议做自己的小产品。", score: 1, tags: [],
  });

  assert.equal(project.narrationSegments?.length, 5);
  assert.ok(project.narration.length >= 384);
  assert.match(project.narration, /薪资依赖.*自主性.*品味.*说服力.*毅力.*迭代/s);
  assert.match(project.narration, /规模可控.*真实问题.*反馈.*修正/s);
  assert.doesNotMatch(project.narration, /记者|媒体|36氪|来源/);
});

test("AI mathematics article fallback separates reported claims from final verification", () => {
  const project = createStoryProject({
    id: "ai-math-breakthrough", kind: "webpage", contentType: "news", title: "突发！OpenAI 下一代 AI 攻克 10 项菲尔兹奖级难题", url: "https://example.com/math", source: "媒体", summary: "Astra 公开多项数学证明。", content: "249页论文讨论10项数学问题，涉及非sofic群、高维球体堆积和刚性猜想，附带Lean 4形式化验证，报道估算成本不到2000美元。结果仍需同行复核。新智元，经授权发布。", score: 1, tags: [],
  });

  assert.equal(project.narrationSegments?.length, 5);
  assert.ok(project.narration.length >= 384);
  assert.match(project.narration, /二百四十九页.*十项.*Lean 4/s);
  assert.match(project.narration, /非 sofic 群.*高维球体堆积.*刚性猜想/s);
  assert.match(project.narration, /仍需.*复核|还不能直接确认/s);
  assert.doesNotMatch(project.narration, /新智元|记者|36氪|论文链接|证明链接/);
});

test("AI mathematics URL fallback restores the canonical title when source parsing fails", () => {
  const project = createStoryProject({
    id: "ai-math-url-fallback", kind: "webpage", contentType: "news", title: "页面标题读取失败", url: "https://www.36kr.com/p/3921682068172419", source: "核心事实", summary: "页面摘要读取失败。", content: "页面正文读取失败。", score: 1, tags: [],
  });

  assert.equal(project.meta.title, "突发！OpenAI下一代AI攻克10项菲尔兹奖级难题");
  assert.equal(project.scenes[0].headline, "突发！OpenAI下一代AI攻克10项菲尔兹奖级难题");
  assert.match(project.narrationSegments![0].text, /^突发！OpenAI下一代AI攻克10项菲尔兹奖级难题/);
});

test("technical article fallback uses explainer structure without news wording", () => {
  const content = Array.from({ length: 12 }, (_, index) => `\u8fd9\u662f\u6280\u672f\u6587\u7ae0\u7684\u7b2c${index + 1}\u4e2a\u5b8c\u6574\u63a8\u5bfc\u6b65\u9aa4\uff0c\u7528\u4e8e\u8bf4\u660e\u6570\u636e\u3001\u5047\u8bbe\u3001\u8ba1\u7b97\u548c\u7ed3\u8bba\u8fb9\u754c\u3002`).join("");
  const item: HotItem = {
    id: "technical-article",
    kind: "webpage",
    contentType: "technical-article",
    title: "\u5229\u7528\u6570\u636e\u4e0e\u8ba1\u7b97\u79d1\u5b66\u63a8\u7b97\u8d4c\u6ce8",
    url: "https://cloud.tencent.com/developer/article/2710377",
    source: "cloud.tencent.com",
    summary: "\u6587\u7ae0\u4ece\u6982\u7387\u548c\u6570\u636e\u51fa\u53d1\uff0c\u5c55\u793a\u5982\u4f55\u5efa\u7acb\u8ba1\u7b97\u8fc7\u7a0b\u3002",
    content,
    publishedAt: "2026-07-17T04:26:11.000Z",
    score: 50,
    tags: ["algorithm"],
  };
  const project = createStoryProject(item);
  assert.equal(project.scenes.length, 5);
  assert.equal(project.scenes[0].type, "title");
  assert.equal(project.scenes[0].kicker, "TECH / EXPLAINER");
  assert.equal(project.narration.includes("\u65b0\u95fb\u65e5\u671f"), false);
  assert.equal(project.narration.includes("\u8fd9\u6761\u65b0\u95fb"), false);
  assert.equal(project.narrationSegments?.[0]?.ttsText?.includes("\u8fd9\u7bc7\u6280\u672f\u6587\u7ae0\u8ba8\u8bba\u7684\u662f"), false);
});

test("repository fallback produces a complete five-scene project without platform promotion", () => {
  const item: HotItem = {
    id: "repository-fallback", kind: "github", contentType: "repository", title: "build-your-own-x: curated implementation guides",
    url: "https://github.com/codecrafters-io/build-your-own-x", source: "项目资料", summary: "step-by-step guides for re-creating technologies from scratch",
    content: "# Build your own <technology> This repository is a compilation of step-by-step guides for re-creating technologies from scratch. * [3D Renderer](#renderer) * [AI Model](#model) * [Database](#database) * [Network Stack](#network) * [Operating System](#os)",
    publishedAt: "2026-07-25T00:00:00.000Z", score: 1, tags: [], repo: "codecrafters-io/build-your-own-x", metrics: { language: "Markdown" },
  };
  const project = createStoryProject(item);
  assert.equal(project.meta.title, "build-your-own-x");
  assert.equal(project.scenes.length, 5);
  assert.equal(project.narrationSegments?.length, 5);
  assert.equal(project.scenes[0].type, "title");
  assert.equal(project.scenes[0].headline, "开源项目推荐：build-your-own-x");
  assert.equal(project.narrationSegments?.[0].text.startsWith("开源项目推荐：build-your-own-x"), true);
  assert.equal(project.narrationSegments?.[0].ttsText?.startsWith("开源项目推荐：Build Your Own X"), true);
  assert.ok(project.narration.replace(/\s/g, "").length >= 240);
  assert.ok(project.meta.durationSeconds >= 50 && project.meta.durationSeconds <= 100);
  assert.equal(containsForbiddenGithubReference([project.meta.title, project.narration, ...project.scenes.map((scene) => JSON.stringify(scene))].join(" "), [item.repo ?? ""]), false);
});

test("MetaGPT repository draft explains the user problem and practical workflow", () => {
  const project = createStoryProject({
    id: "metagpt", kind: "github", contentType: "repository", title: "MetaGPT: Multi-Agent Framework", url: "https://github.com/FoundationAgents/MetaGPT", source: "项目资料", summary: "AI Software Company", content: "MetaGPT is a multi-agent framework for building software.", score: 1, tags: [], repo: "FoundationAgents/MetaGPT",
  });

  assert.match(project.narrationSegments![0].text, /软件想法/);
  assert.match(project.narrationSegments![1].text, /自然语言需求/);
  assert.match(project.narrationSegments![3].text, /一句话说明要做什么/);
});

test("OfficeCLI repository draft explains direct office-file use", () => {
  const project = createStoryProject({
    id: "officecli", kind: "github", contentType: "repository", title: "OfficeCLI: Office suite for AI agents", url: "https://github.com/iOfficeAI/OfficeCLI", source: "项目资料", summary: "Office suite", content: "Read and write Word, Excel, spreadsheet and presentation files.", score: 1, tags: [], repo: "iOfficeAI/OfficeCLI",
  });

  assert.match(project.narrationSegments![0].text, /文档、表格和演示文稿/);
  assert.match(project.narrationSegments![1].text, /办公文件/);
  assert.match(project.narrationSegments![3].text, /汇总表格/);
});

test("AI-For-Beginners repository draft explains the structured learning curriculum", () => {
  const project = createStoryProject({
    id: "ai-for-beginners", kind: "github", contentType: "repository", title: "AI-For-Beginners: Artificial Intelligence for Beginners - A Curriculum", url: "https://github.com/microsoft/AI-For-Beginners", source: "项目资料", summary: "A 12-week, 24-lesson curriculum", content: "Explore artificial intelligence with a 12-week, 24-lesson curriculum including quizzes, labs, TensorFlow, PyTorch, computer vision, NLP and ethics.", score: 1, tags: [], repo: "microsoft/AI-For-Beginners",
  });

  assert.equal(project.meta.title, "AI-For-Beginners");
  assert.match(project.narrationSegments![0].text, /人工智能入门课程/);
  assert.match(project.narrationSegments![1].text, /十二周、二十四课/);
  assert.match(project.narrationSegments![3].text, /选择语言.*学习概念.*测验和实验/);
  assert.doesNotMatch(project.narration, /文档、表格和演示文稿/);
});

test("ESP32-Bit-Pirate repository draft explains multi-protocol hardware analysis", () => {
  const project = createStoryProject({
    id: "esp32-bit-pirate", kind: "github", contentType: "repository", title: "ESP32-Bit-Pirate: multi-protocol development tool", url: "https://github.com/geo-tp/ESP32-Bit-Pirate", source: "项目资料", summary: "ESP32 multi-protocol tool", content: "Firmware inspired by Bus Pirate with I2C, SPI, UART, CAN, infrared, Bluetooth, Wi-Fi, Sub-GHz, RFID and a mobile web interface presentation.", score: 1, tags: [], repo: "geo-tp/ESP32-Bit-Pirate",
  });

  assert.match(project.narrationSegments![0].text, /多协议硬件调试与分析工具/);
  assert.match(project.narrationSegments![1].text, /I2C.*SPI.*UART.*CAN/);
  assert.match(project.narrationSegments![3].text, /确认开发板电压和引脚.*刷入固件.*网页终端/);
  assert.doesNotMatch(project.narration, /文档、表格和演示文稿/);
});

test("Bifrost repository draft explains the model gateway and direct setup path", () => {
  const project = createStoryProject({
    id: "bifrost", kind: "github", contentType: "repository", title: "bifrost: enterprise AI gateway", url: "https://github.com/maximhq/bifrost", source: "项目资料", summary: "OpenAI-compatible gateway", content: "Bifrost is an enterprise AI gateway for 23+ providers with automatic fallbacks, load balancing, semantic caching, budgets and observability.", score: 1, tags: [], repo: "maximhq/bifrost",
  });

  assert.match(project.narrationSegments![0].text, /模型网关/);
  assert.match(project.narrationSegments![1].text, /二十三家以上模型服务/);
  assert.match(project.narrationSegments![2].text, /故障切换.*负载均衡.*语义缓存/);
  assert.match(project.narrationSegments![3].text, /启动网关.*配置模型服务和密钥.*接口地址/);
  assert.doesNotMatch(project.narrationSegments!.map((segment) => segment.text).join(" "), /选择主题|阅读结构|下面看/);
  assert.ok(project.narrationSegments!.every((segment) => segment.text.length <= 125));
});

test("T3 Code repository draft explains its coding-agent workspace", () => {
  const project = createStoryProject({
    id: "t3code", kind: "github", contentType: "repository", title: "t3code: minimal web GUI for coding agents", url: "https://github.com/pingdotgg/t3code", source: "项目资料", summary: "Web GUI for coding agents", content: "T3 Code is a minimal web GUI for coding agents including Codex, Claude, Cursor, and OpenCode.", score: 1, tags: [], repo: "pingdotgg/t3code",
  });

  assert.equal(project.meta.title, "t3code");
  assert.match(project.narrationSegments![0].text, /网页和桌面工作台/);
  assert.match(project.narrationSegments![1].text, /统一图形界面/);
  assert.match(project.narrationSegments![3].text, /安装并登录.*启动 T3 Code.*选择项目/);
  assert.doesNotMatch(project.narration, /选择主题|阅读结构/);
});

test("speech-to-speech repository draft explains the realtime voice pipeline", () => {
  const project = createStoryProject({
    id: "speech-to-speech", kind: "github", contentType: "repository", title: "speech-to-speech: Build local voice agents", url: "https://github.com/huggingface/speech-to-speech", source: "项目资料", summary: "Low-latency modular voice-agent pipeline", content: "A low-latency modular voice-agent pipeline: VAD, STT, LLM and TTS through an OpenAI Realtime-compatible API.", score: 1, tags: [], repo: "huggingface/speech-to-speech",
  });

  assert.equal(project.meta.title, "speech-to-speech");
  assert.match(project.narrationSegments![0].text, /低延迟语音智能体/);
  assert.match(project.narrationSegments![1].text, /语音活动检测.*语音识别.*大模型.*语音合成/);
  assert.match(project.narrationSegments![3].text, /实时服务.*真实对话.*延迟/);
  assert.doesNotMatch(project.narration, /选择主题|阅读结构/);
});

test("aisuite repository draft explains provider switching and agent tools", () => {
  const project = createStoryProject({
    id: "aisuite", kind: "github", contentType: "repository", title: "aisuite: unified interface to multiple Generative AI providers", url: "https://github.com/andrewyng/aisuite", source: "项目资料", summary: "Unified Chat Completions and Agents APIs", content: "One API across multiple LLM providers with Agents API, toolkits and MCP tools.", score: 1, tags: [], repo: "andrewyng/aisuite",
  });

  assert.equal(project.meta.title, "aisuite");
  assert.match(project.narrationSegments![0].text, /一套 Python 接口/);
  assert.match(project.narrationSegments![1].text, /修改模型名称.*切换供应商/);
  assert.match(project.narrationSegments![3].text, /供应商扩展.*统一客户端.*工具/);
  assert.doesNotMatch(project.narration, /选择主题|阅读结构/);
});

test("Kaneo repository draft explains simple self-hosted project management", () => {
  const project = createStoryProject({
    id: "kaneo", kind: "github", contentType: "repository", title: "kaneo: open source project management", url: "https://github.com/usekaneo/kaneo", source: "项目资料", summary: "Self-hosted project management", content: "Clean self-hosted project management with kanban, Docker Compose and PostgreSQL.", score: 1, tags: [], repo: "usekaneo/kaneo",
  });

  assert.equal(project.meta.title, "kaneo");
  assert.equal(project.scenes[0].headline, "开源项目推荐：kaneo");
  assert.match(project.narrationSegments![1].text, /任务、进度和负责人/);
  assert.match(project.narrationSegments![3].text, /Docker Compose.*PostgreSQL.*创建项目/);
  assert.doesNotMatch(project.narration, /github\.com|GitHub|仓库地址/i);
});

test("copilot-sdk repository draft explains embedded coding agents", () => {
  const project = createStoryProject({
    id: "copilot-sdk", kind: "github", contentType: "repository", title: "copilot-sdk: agents for every app", url: "https://github.com/github/copilot-sdk", source: "项目资料", summary: "Multi-platform SDK", content: "Embed agentic workflows in apps with Python, TypeScript, Go, .NET, Java and Rust. Planning, tool invocation and file edits over JSON-RPC.", score: 1, tags: [], repo: "github/copilot-sdk",
  });

  assert.equal(project.meta.title, "copilot-sdk");
  assert.equal(project.scenes[0].headline, "开源项目推荐：copilot-sdk");
  assert.match(project.narrationSegments![1].text, /任务规划、工具调用和文件修改/);
  assert.match(project.narrationSegments![3].text, /项目语言安装.*创建客户端和会话.*工具权限/s);
  assert.doesNotMatch(project.narration, /github\.com|GitHub|仓库地址/i);
});

test("DeerFlow repository draft explains long-running agent work", () => {
  const project = createStoryProject({
    id: "deer-flow", kind: "github", contentType: "repository", title: "deer-flow: super agent harness", url: "https://github.com/bytedance/deer-flow", source: "项目资料", summary: "Long-horizon agent harness", content: "Super agent harness with sub-agents, memory, sandboxes, tools and skills for research, coding and content tasks.", score: 1, tags: [], repo: "bytedance/deer-flow",
  });

  assert.equal(project.meta.title, "deer-flow");
  assert.equal(project.scenes[0].headline, "开源项目推荐：deer-flow");
  assert.match(project.narrationSegments![1].text, /子智能体、长期记忆、沙箱、工具和可扩展技能/);
  assert.match(project.narrationSegments![3].text, /安装向导.*安全的沙箱.*具体研究或代码任务/s);
  assert.doesNotMatch(project.narration, /火山|方舟|github\.com|GitHub|仓库地址/i);
});

test("awesome-systematic-trading repository draft stays educational and grounded", () => {
  const project = createStoryProject({
    id: "awesome-systematic-trading", kind: "github", contentType: "repository", title: "awesome-systematic-trading: quantitative trading resources", url: "https://github.com/paperswithbacktest/awesome-systematic-trading", source: "项目资料", summary: "A curated list of resources for systematic trading", content: "A collection of 97 libraries and packages, 40+ strategies, 55 books, videos, blogs and courses for quantitative trading.", score: 1, tags: [], repo: "paperswithbacktest/awesome-systematic-trading",
  });

  assert.equal(project.meta.title, "awesome-systematic-trading");
  assert.equal(project.scenes[0].headline, "开源项目推荐：awesome-systematic-trading");
  assert.match(project.narrationSegments![1].text, /回测框架、交易库、数据工具/);
  assert.match(project.narrationSegments![3].text, /历史数据.*收益、回撤和交易成本.*模拟或实盘/s);
  assert.match(project.narration, /不是投资建议/);
  assert.doesNotMatch(project.narration, /github\.com|GitHub|仓库地址/i);
});

test("Voice-Pro repository draft explains the end-to-end dubbing workflow", () => {
  const project = createStoryProject({
    id: "voice-pro", kind: "github", contentType: "repository", title: "Voice-Pro: AI speech recognition and multilingual dubbing", url: "https://github.com/abus-aikorea/voice-pro", source: "项目资料", summary: "Speech recognition, translation and dubbing web application", content: "Speech recognition, translation, dubbing, F5-TTS, CosyVoice, Edge-TTS, Whisper and voice cloning.", score: 1, tags: [], repo: "abus-aikorea/voice-pro",
  });

  assert.equal(project.meta.title, "voice-pro");
  assert.equal(project.scenes[0].headline, "开源项目推荐：voice-pro");
  assert.match(project.narrationSegments![1].text, /视频下载、语音分离、字幕识别、跨语言翻译和文本转语音/);
  assert.match(project.narrationSegments![3].text, /导入.*分离人声.*识别文本.*生成配音/s);
  assert.match(project.narration, /音色克隆必须获得授权/);
  assert.doesNotMatch(project.narration, /github\.com|GitHub|仓库地址/i);
});

test("Ansible repository draft explains agentless infrastructure automation", () => {
  const project = createStoryProject({
    id: "ansible", kind: "github", contentType: "repository", title: "ansible: IT automation", url: "https://github.com/ansible/ansible", source: "项目资料", summary: "Simple agentless IT automation", content: "Configuration management, application deployment, cloud provisioning, network automation and multi-node orchestration using SSH without agents.", score: 1, tags: [], repo: "ansible/ansible",
  });

  assert.equal(project.meta.title, "ansible");
  assert.equal(project.scenes[0].headline, "开源项目推荐：ansible");
  assert.match(project.narrationSegments![1].text, /人和机器都能读懂的任务文件.*配置管理、应用部署/);
  assert.match(project.narrationSegments![3].text, /安装 Ansible.*SSH.*playbook.*测试机器/s);
  assert.match(project.narration, /无需安装专用代理/);
  assert.doesNotMatch(project.narration, /github\.com|GitHub|仓库地址/i);
});
