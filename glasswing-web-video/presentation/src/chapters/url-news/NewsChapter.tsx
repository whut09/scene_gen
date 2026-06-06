import type { CSSProperties } from "react";
import { ConnectorLine, GlowGrid, SceneShell, SceneStatus, SignalCard, TerminalFrame } from "../../components/visual";
import type { ChapterStepProps } from "../../registry/types";
import { NEWS_STORY } from "./story-data";
import "./NewsChapter.css";

const metrics = [
  { label: "输出速度", value: "416", unit: "tokens/s" },
  { label: "输入价格", value: "$0.2", unit: "/M token" },
  { label: "输出价格", value: "$1.15", unit: "/M token" },
  { label: "缓存命中", value: "86.1%", unit: "全球第二" },
];

const voteData = [
  { label: "AI点菜", value: 11 },
  { label: "拼单", value: 10 },
  { label: "深夜配送", value: 8 },
  { label: "会员折扣", value: 6 },
  { label: "碳积分", value: 5 },
];

const speedData = [
  { label: "主流模型", value: 30 },
  { label: "多数模型", value: 100 },
  { label: "Step 3.7", value: 416 },
];

const agentNodes = ["搜索", "工具调用", "多轮检索", "拆解任务", "表格/报告", "交付"];
const demoTags = ["灵巧手识图", "报销文件", "40 Agent", "产品评审", "投票汇总"];

function clampStep(chapterIndex: number, step: number) {
  const chapter = NEWS_STORY.chapters[chapterIndex] ?? NEWS_STORY.chapters[0];
  return {
    chapter,
    current: chapter.steps[Math.max(0, Math.min(step, chapter.steps.length - 1))]!,
  };
}

function Facts({ facts }: { facts: readonly string[] }) {
  return (
    <ul className="qn-facts mono">
      {facts.slice(0, 3).map((fact) => (
        <li key={fact}>{fact}</li>
      ))}
    </ul>
  );
}

function SourceShot() {
  return (
    <TerminalFrame className="qn-source-shot" label="SOURCE / QbitAI" status="captured">
      <img src={NEWS_STORY.sourceScreenshot} alt="" />
    </TerminalFrame>
  );
}

function MetricDeck() {
  return (
    <div className="qn-metric-deck">
      {metrics.map((item, index) => (
        <div key={item.label} className="qn-metric-card" style={{ "--i": index } as CSSProperties}>
          <span className="mono">{item.label}</span>
          <strong>{item.value}</strong>
          <small className="mono">{item.unit}</small>
        </div>
      ))}
    </div>
  );
}

function AgentFlow() {
  return (
    <div className="qn-agent-flow">
      {agentNodes.map((node, index) => (
        <div key={node} className="qn-flow-node" style={{ "--i": index } as CSSProperties}>
          <span className="mono">0{index + 1}</span>
          <strong>{node}</strong>
        </div>
      ))}
    </div>
  );
}

function VoteChart() {
  return (
    <div className="qn-vote-chart">
      {voteData.map((item, index) => (
        <div key={item.label} className="qn-vote-row" style={{ "--i": index, "--v": item.value } as CSSProperties}>
          <span className="mono">{item.label}</span>
          <i />
          <strong>{item.value}票</strong>
        </div>
      ))}
    </div>
  );
}

function SpeedChart() {
  return (
    <div className="qn-speed-chart">
      {speedData.map((item, index) => (
        <div key={item.label} className="qn-speed-bar" style={{ "--i": index, "--v": item.value } as CSSProperties}>
          <span className="mono">{item.label}</span>
          <i />
          <strong>{item.value} tps</strong>
        </div>
      ))}
    </div>
  );
}

function DemoGrid() {
  return (
    <div className="qn-demo-grid">
      {demoTags.map((tag, index) => (
        <div key={tag} style={{ "--i": index } as CSSProperties}>
          <span className="mono">CASE 0{index + 1}</span>
          <strong>{tag}</strong>
        </div>
      ))}
    </div>
  );
}

function SceneVisual({ chapterIndex, step }: { chapterIndex: number; step: number }) {
  if (chapterIndex === 0 && step <= 2) {
    return (
      <div className="qn-visual qn-visual-source">
        <SourceShot />
        <MetricDeck />
      </div>
    );
  }

  if (chapterIndex === 0) {
    return (
      <div className="qn-visual qn-visual-speed">
        <MetricDeck />
        <div className="qn-token-stream mono">
          {Array.from({ length: 34 }, (_, index) => (
            <span key={index} style={{ "--i": index } as CSSProperties}>token</span>
          ))}
        </div>
      </div>
    );
  }

  if (chapterIndex === 1) {
    return (
      <div className="qn-visual qn-visual-flow">
        <AgentFlow />
        <SignalCard accent>Token效率 = 速度 + 成本 + 稳定交付</SignalCard>
      </div>
    );
  }

  if (chapterIndex === 2 && step >= 7) {
    return <VoteChart />;
  }

  if (chapterIndex === 2) {
    return (
      <div className="qn-visual qn-visual-demo">
        <DemoGrid />
        <AgentFlow />
      </div>
    );
  }

  if (step <= 2) {
    return <SpeedChart />;
  }

  if (step <= 7) {
    return (
      <div className="qn-visual qn-visual-economics">
        <MetricDeck />
        <SignalCard>单位成本下，跑完更多真实任务</SignalCard>
      </div>
    );
  }

  return (
    <div className="qn-visual qn-visual-final">
      <SignalCard>从谁更聪明</SignalCard>
      <ConnectorLine />
      <SignalCard accent>到谁更快、更稳、更便宜</SignalCard>
    </div>
  );
}

export function NewsChapter({ chapterIndex, step }: ChapterStepProps & { chapterIndex: number }) {
  const { chapter, current } = clampStep(chapterIndex, step);
  const isFinal = chapterIndex === NEWS_STORY.chapters.length - 1 && step === chapter.steps.length - 1;

  return (
    <SceneShell className={["qn-shell", isFinal ? "qn-final-nature" : ""].filter(Boolean).join(" ")}>
      <SceneStatus
        left="量子位 / QbitAI"
        center={`第 ${step + 1} / ${chapter.steps.length} 屏`}
        right="Step 3.7 Flash"
      />
      <GlowGrid cells={48} />

      <main className="qn-layout">
        <section className="qn-copy">
          <span className="qn-kicker mono">{chapter.title}</span>
          <h1>{current.screenText}</h1>
          <p>{current.narration}</p>
          <Facts facts={current.facts} />
        </section>

        <SceneVisual chapterIndex={chapterIndex} step={step} />
      </main>
    </SceneShell>
  );
}
