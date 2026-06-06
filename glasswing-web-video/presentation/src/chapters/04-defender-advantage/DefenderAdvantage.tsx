import type { CSSProperties } from "react";
import type { ChapterStepProps } from "../../registry/types";
import "./DefenderAdvantage.css";

const legacyLines = ["unsafe pointer", "manual memory", "buffer risk", "legacy module"];
const safeLines = ["bounds checked", "ownership", "safe runtime", "verified patch"];
const scaleNodes = Array.from({ length: 72 }, (_, i) => i);
const process = ["发现", "确认", "披露", "修补", "测试", "部署"];

function Status({ step }: { step: number }) {
  return (
    <div className="da-status mono">
      <span>防守方优势</span>
      <span>第 {step + 1} / 7 屏</span>
      <span>最终判断</span>
    </div>
  );
}

export default function DefenderAdvantage({ step }: ChapterStepProps) {
  if (step === 0) {
    return (
      <div className="da-scene da-rewrite">
        <Status step={step} />
        <h2>把遗留代码，重建成更安全的语言</h2>
        <div className="da-code-pair mono">
          <div>
            <span>遗留代码</span>
            {legacyLines.map((line, i) => <code key={line} style={{ "--i": i } as CSSProperties}>{line}</code>)}
          </div>
          <strong>→</strong>
          <div>
            <span>内存安全</span>
            {safeLines.map((line, i) => <code key={line} style={{ "--i": i } as CSSProperties}>{line}</code>)}
          </div>
        </div>
      </div>
    );
  }

  if (step === 1) {
    return (
      <div className="da-scene da-dual">
        <Status step={step} />
        <span className="mono">同一种能力，两个方向</span>
        <div className="da-fork">
          <div>
            <strong>防守方</strong>
            <p>修补、检测、响应</p>
          </div>
          <div>
            <strong>攻击者</strong>
            <p>扫描、利用、自动化</p>
          </div>
        </div>
        <i className="da-split" />
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="da-scene da-gap">
        <Status step={step} />
        <span className="mono">官方承认的缺口</span>
        <h2>保护措施还不够稳健，也不够精确</h2>
        <div className="da-gap-box mono">
          <span>安全护栏</span>
          <strong>尚未完成</strong>
          <span>风险仍在扩大</span>
        </div>
      </div>
    );
  }

  if (step === 3) {
    return (
      <div className="da-scene da-scale">
        <Status step={step} />
        <span className="mono">未来需求规模</span>
        <strong className="hero-num">数十万</strong>
        <p>组织、研究人员和维护者，都可能需要高级网络安全工具。</p>
        <div className="da-scale-grid">
          {scaleNodes.map((node) => <i key={node} style={{ "--i": node } as CSSProperties} />)}
        </div>
      </div>
    );
  }

  if (step === 4) {
    return (
      <div className="da-scene da-not-race">
        <Status step={step} />
        <span className="mono">不是扫描比赛</span>
        <h2>目标不是比谁先扫出更多漏洞</h2>
        <div className="da-cross mono">
          <strong>漏洞数量</strong>
          <i />
          <span>不是最终胜负手</span>
        </div>
      </div>
    );
  }

  if (step === 5) {
    return (
      <div className="da-scene da-process">
        <Status step={step} />
        <span className="mono">真正要改变的是流程</span>
        <h2>从发现，到修完并上线</h2>
        <div className="da-process-line">
          {process.map((item, i) => (
            <div key={item} style={{ "--i": i } as CSSProperties}>
              <span>0{i + 1}</span>
              <strong>{item}</strong>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="da-scene da-final">
      <Status step={step} />
      <span className="mono">最终信号</span>
      <h2>AI 安全真正的比赛</h2>
      <div className="da-final-quote">
        <strong>不是谁先找到漏洞</strong>
        <i />
        <strong>而是谁更快、更安全地修完</strong>
      </div>
    </div>
  );
}
