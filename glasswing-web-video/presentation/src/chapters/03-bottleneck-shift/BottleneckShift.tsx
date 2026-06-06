import type { CSSProperties } from "react";
import type { ChapterStepProps } from "../../registry/types";
import "./BottleneckShift.css";

const modelDots = Array.from({ length: 36 }, (_, i) => i);
const queue = ["确认真假", "安全披露", "写补丁", "回归测试", "部署上线"];
const toolUses = ["写补丁", "发布前检查", "渗透测试", "威胁检测", "事件响应"];

function Status({ step }: { step: number }) {
  return (
    <div className="bs-status mono">
      <span>瓶颈转移</span>
      <span>第 {step + 1} / 6 屏</span>
      <span>修复队列</span>
    </div>
  );
}

export default function BottleneckShift({ step }: ChapterStepProps) {
  if (step === 0) {
    return (
      <div className="bs-scene bs-why">
        <Status step={step} />
        <span className="mono">扩大的原因</span>
        <h2>强网络能力的 AI，已经很近了</h2>
        <div className="bs-three">
          {["便宜", "快速", "能联网"].map((item, i) => (
            <div key={item} style={{ "--i": i } as CSSProperties}>
              <strong>{item}</strong>
              <i />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (step === 1) {
    return (
      <div className="bs-scene bs-window">
        <Status step={step} />
        <span className="mono">能力扩散窗口</span>
        <strong className="hero-num">6-12</strong>
        <p>未来几个月，很多公司都可能拥有 Mythos 级别模型。</p>
        <div className="bs-model-field">
          {modelDots.map((dot) => (
            <i key={dot} style={{ "--i": dot } as CSSProperties} />
          ))}
        </div>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="bs-scene bs-risk">
        <Status step={step} />
        <h2>如果保护措施跟不上</h2>
        <div className="bs-risk-stack mono">
          <div><span>模型发布</span><strong>↑</strong></div>
          <div><span>攻击频率</span><strong>↑</strong></div>
          <div><span>可预测性</span><strong>↓</strong></div>
        </div>
        <p>同样的网络能力，可以帮防守方，也可能被攻击者滥用。</p>
      </div>
    );
  }

  if (step === 3) {
    return (
      <div className="bs-scene bs-before">
        <Status step={step} />
        <span className="mono">旧问题</span>
        <h2>以前最难的是：</h2>
        <strong>能不能发现漏洞？</strong>
        <div className="bs-before-scan" />
      </div>
    );
  }

  if (step === 4) {
    return (
      <div className="bs-scene bs-after">
        <Status step={step} />
        <span className="mono">新瓶颈</span>
        <h2>发现之后，队列才开始变长</h2>
        <div className="bs-queue">
          {queue.map((item, i) => (
            <div key={item} style={{ "--i": i } as CSSProperties}>
              <span>0{i + 1}</span>
              <strong>{item}</strong>
              <i />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="bs-scene bs-tools">
      <Status step={step} />
      <span className="mono">Mythos 的防守用途</span>
      <h2>它不只是扫描器</h2>
      <div className="bs-tool-list">
        {toolUses.map((item, i) => (
          <div key={item} style={{ "--i": i } as CSSProperties}>
            <span>{String(i + 1).padStart(2, "0")}</span>
            <strong>{item}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
