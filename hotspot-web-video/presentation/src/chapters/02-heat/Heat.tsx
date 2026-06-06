import type { ChapterStepProps } from "../../registry/types";
import "./Heat.css";

const points = [
  { label: "Hacker News points", value: "698", width: "64%" },
  { label: "Comments", value: "1224", width: "92%" },
];

export default function Heat({ step }: ChapterStepProps) {
  return (
    <section className="ht-page">
      <div className="ht-dateline">HN discussion · 2026-06-01 · economist.com</div>

      {step === 0 && (
        <div className="ht-market">
          <div className="ht-tape">
            <span>openai</span>
            <span>anthropic</span>
            <span>valuation</span>
            <span>ipo window</span>
          </div>
          <div className="ht-big-number hero-num">698</div>
          <h1>points</h1>
          <p>技术圈不是随手点了个赞，它把这条财经标题推成了热点。</p>
        </div>
      )}

      {step === 1 && (
        <div className="ht-bars">
          {points.map((item) => (
            <div className="ht-bar-row" key={item.label}>
              <div className="ht-bar-meta">
                <span>{item.label}</span>
                <b>{item.value}</b>
              </div>
              <div className="ht-track">
                <div className="ht-fill" style={{ width: item.width }} />
              </div>
            </div>
          ))}
          <p>1224 条评论意味着：观众不只是在看新闻，而是在争论假设。</p>
        </div>
      )}

      {step === 2 && (
        <div className="ht-converge">
          <div className="ht-lane">
            <strong>tech crowd</strong>
            <span>models · agents · OpenAI</span>
          </div>
          <div className="ht-node">same story</div>
          <div className="ht-lane ht-lane-right">
            <strong>capital crowd</strong>
            <span>ipo · liquidity · valuation</span>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="ht-verdict">
          <div className="ht-stamp">not a normal finance headline</div>
          <h1>跨圈层争议</h1>
          <p>它把模型公司、未上市巨头、退出路径放进同一个问题里。</p>
        </div>
      )}
    </section>
  );
}
