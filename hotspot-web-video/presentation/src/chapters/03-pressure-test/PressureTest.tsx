import type { ChapterStepProps } from "../../registry/types";
import "./PressureTest.css";

const gates = ["cash flow", "IPO window", "exit path"];
const assets = ["Anthropic", "OpenAI", "SpaceX"];

export default function PressureTest({ step }: ChapterStepProps) {
  return (
    <section className="pt-page">
      <div className="pt-label">capital market pressure test</div>

      {step === 0 && (
        <div className="pt-transfer">
          <div className="pt-market card">
            <span>private market</span>
            <b>valuation</b>
          </div>
          <div className="pt-rail">
            <i />
          </div>
          <div className="pt-market pt-market-hot card">
            <span>public market</span>
            <b>real buyers</b>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="pt-model">
          <h1>Not only model capability</h1>
          <div className="pt-model-stack">
            <div>benchmark</div>
            <div>product usage</div>
            <div>revenue quality</div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="pt-gates">
          {gates.map((gate, index) => (
            <div className="pt-gate" key={gate}>
              <span className="hero-num">{index + 1}</span>
              <b>{gate}</b>
            </div>
          ))}
        </div>
      )}

      {step === 3 && (
        <div className="pt-final">
          <div className="pt-queue">
            {assets.map((asset) => (
              <div className="pt-asset card" key={asset}>
                {asset}
              </div>
            ))}
          </div>
          <h1>资本市场还能继续买单吗？</h1>
          <p>这才是这条热点真正值得单独成片的角度。</p>
        </div>
      )}
    </section>
  );
}
