import type { ChapterStepProps } from "../../registry/types";
import "./Coldopen.css";

const companies = ["Anthropic", "SpaceX", "OpenAI"];

export default function Coldopen({ step }: ChapterStepProps) {
  return (
    <section className="co-page">
      <div className="co-masthead">
        <span>AI CAPITAL WATCH</span>
        <span>June 2026</span>
      </div>

      {step === 0 && (
        <div className="co-headline co-headline-enter">
          <p className="co-kicker">The question is not valuation.</p>
          <h1>Can the stockmarket swallow Anthropic, SpaceX and OpenAI?</h1>
          <div className="rule" />
        </div>
      )}

      {step === 1 && (
        <div className="co-cut">
          <div className="co-cut-block">stockmarket</div>
          <div className="co-cut-block co-cut-accent">swallow</div>
          <div className="co-cut-block">three giants</div>
          <p>一个标题，被切开以后，就变成了资本市场的压力问题。</p>
        </div>
      )}

      {step === 2 && (
        <div className="co-ledger">
          <div className="co-ledger-line" />
          {companies.map((name, index) => (
            <div className="co-company card" key={name}>
              <span className="hero-num">0{index + 1}</span>
              <strong>{name}</strong>
              <small>{index === 1 ? "private space asset" : "frontier AI asset"}</small>
            </div>
          ))}
        </div>
      )}

      {step === 3 && (
        <div className="co-turn">
          <div className="co-ticket card">
            <span>ordinary headline</span>
            <b>another funding story</b>
          </div>
          <div className="co-arrow" />
          <div className="co-ticket co-ticket-hot card">
            <span>real question</span>
            <b>who buys the asset?</b>
          </div>
        </div>
      )}
    </section>
  );
}
