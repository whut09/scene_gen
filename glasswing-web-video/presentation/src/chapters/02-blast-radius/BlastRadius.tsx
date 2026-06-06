import type { CSSProperties } from "react";
import type { ChapterStepProps } from "../../registry/types";
import "./BlastRadius.css";

const sectors = ["电力", "水务", "医疗", "通信", "硬件"];
const countries = ["美国", "英国", "日本", "德国", "法国", "印度", "新加坡", "韩国", "加拿大", "澳洲", "巴西", "荷兰", "瑞典", "以色列", "阿联酋"];
const chain = ["维护者", "基础库", "厂商", "政府", "医院", "电网", "普通用户"];

function Status({ step }: { step: number }) {
  return (
    <div className="br-status mono">
      <span>扩张半径</span>
      <span>第 {step + 1} / 6 屏</span>
      <span>风险地图</span>
    </div>
  );
}

export default function BlastRadius({ step }: ChapterStepProps) {
  if (step === 0) {
    return (
      <div className="br-scene br-expand">
        <Status step={step} />
        <div className="br-title mono">新增组织</div>
        <div className="br-number hero-num">150</div>
        <div className="br-plus">+</div>
        <div className="br-expand-grid">
          {Array.from({ length: 60 }, (_, i) => (
            <i key={i} style={{ "--i": i } as CSSProperties} />
          ))}
        </div>
        <p>Project Glasswing 从 50 个初始伙伴，进入更大规模的防守协作。</p>
      </div>
    );
  }

  if (step === 1) {
    return (
      <div className="br-scene br-gate">
        <Status step={step} />
        <h2>不是开放注册</h2>
        <div className="br-gate-box mono">
          <span>加入前检查</span>
          <strong>安全要求</strong>
          <span>未满足 → 拒绝接入</span>
        </div>
        <div className="br-gate-bars">
          {["身份验证", "使用边界", "漏洞披露", "日志审计"].map((item, i) => (
            <div key={item} style={{ "--i": i } as CSSProperties}>
              <span>{item}</span>
              <i />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="br-scene br-map">
        <Status step={step} />
        <div className="br-map-copy">
          <span className="mono">国家覆盖</span>
          <strong className="hero-num">15+</strong>
          <p>新伙伴来自超过十五个国家，防守范围开始跨国扩散。</p>
        </div>
        <div className="br-country-cloud">
          {countries.map((name, i) => (
            <span key={name} style={{ "--i": i } as CSSProperties}>{name}</span>
          ))}
        </div>
      </div>
    );
  }

  if (step === 3) {
    return (
      <div className="br-scene br-sector">
        <Status step={step} />
        <div className="br-sector-head">
          <span className="mono">关键行业</span>
          <h2>漏洞不只影响软件公司</h2>
        </div>
        <div className="br-sector-list">
          {sectors.map((sector, i) => (
            <div className="br-sector-item" key={sector} style={{ "--i": i } as CSSProperties}>
              <span>0{i + 1}</span>
              <strong>{sector}</strong>
              <i />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (step === 4) {
    return (
      <div className="br-scene br-chain">
        <Status step={step} />
        <h2>供应链会把风险放大</h2>
        <div className="br-chain-line">
          {chain.map((item, i) => (
            <div key={item} className="br-chain-node" style={{ "--i": i } as CSSProperties}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <strong>{item}</strong>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="br-scene br-impact">
      <Status step={step} />
      <div className="br-impact-ring" />
      <span className="mono">重大攻击潜在影响</span>
      <strong className="hero-num">100M+</strong>
      <p>超过一亿人可能受影响。防守不是修一个项目，而是在保护一整条社会依赖链。</p>
    </div>
  );
}
