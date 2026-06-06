import type { CSSProperties } from "react";
import type { ChapterStepProps } from "../../registry/types";
import "./BreachCount.css";

const partnerNodes = Array.from({ length: 50 }, (_, index) => index);
const codeLines = [
  "auth/session/validate.ts",
  "infra/gateway/route.go",
  "runtime/parser/memory.c",
  "packages/crypto/token.rs",
  "services/billing/webhook.py",
  "core/permissions/policy.ts",
  "platform/worker/process.cc",
  "api/files/archive.java",
];
const repairStages = ["DISCOVER", "VERIFY", "DISCLOSE", "PATCH", "DEPLOY"];
const repairStagesZh = ["发现", "验证", "披露", "修补", "部署"];

function StatusLine({ step }: { step: number }) {
  return (
    <div className="bc-status mono">
      <span>项目：Glasswing</span>
      <span>第 {step + 1} / 5 屏</span>
      <span className="bc-live">扫描中</span>
    </div>
  );
}

export default function BreachCount({ step }: ChapterStepProps) {
  if (step === 0) {
    return (
      <div className="bc-scene bc-count">
        <StatusLine step={step} />
        <div className="bc-count-grid" aria-hidden="true">
          {Array.from({ length: 72 }, (_, index) => (
            <span key={index} style={{ "--i": index } as CSSProperties} />
          ))}
        </div>
        <div className="bc-scanline" />
        <div className="bc-count-copy">
          <div className="bc-eyebrow mono">Claude Mythos Preview / 安全扫描</div>
          <div className="bc-number hero-num">10,000+</div>
          <div className="bc-severity-row mono">
            <span>高危</span>
            <span>或</span>
            <span>严重</span>
          </div>
          <p>一次扫描发现的高危与严重级别漏洞</p>
        </div>
        <div className="bc-count-meter mono">
          <span>扫描进度</span>
          <i />
          <b>完成</b>
        </div>
      </div>
    );
  }

  if (step === 1) {
    return (
      <div className="bc-scene bc-source">
        <StatusLine step={step} />
        <div className="bc-source-shot">
          <img
            src="/assets/glasswing-official.png"
            alt="Anthropic Expanding Project Glasswing official article"
          />
          <div className="bc-source-focus" />
          <div className="bc-crosshair bc-crosshair-a">+</div>
          <div className="bc-crosshair bc-crosshair-b">+</div>
        </div>
        <div className="bc-source-caption mono">
          <span>官方来源</span>
          <strong>Anthropic 扩大 Project Glasswing</strong>
          <span>2026 年 6 月 2 日</span>
        </div>
        <div className="bc-source-proof mono">
          <span>项目定义</span>
          <strong>保护全球关键软件</strong>
          <span>状态：正在扩张</span>
        </div>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="bc-scene bc-network">
        <StatusLine step={step} />
        <div className="bc-network-title">
          <span className="mono">4 月初 / 首批接入</span>
          <strong className="hero-num">50</strong>
          <p>初始合作伙伴接入 Claude Mythos Preview</p>
        </div>
        <div className="bc-node-field">
          <div className="bc-core mono">
            <span>CLAUDE</span>
            <strong>MYTHOS</strong>
            <span>PREVIEW</span>
          </div>
          {partnerNodes.map((node) => {
            const angle = (node / partnerNodes.length) * Math.PI * 2;
            const ring = node % 3;
            const radiusX = 320 + ring * 150;
            const radiusY = 190 + ring * 95;
            const x = 50 + Math.cos(angle) * (radiusX / 14.8);
            const y = 50 + Math.sin(angle) * (radiusY / 8.5);
            return (
              <span
                className="bc-node"
                key={node}
                style={
                  {
                    "--x": `${x}%`,
                    "--y": `${y}%`,
                    "--i": node,
                  } as CSSProperties
                }
              >
                {String(node + 1).padStart(2, "0")}
              </span>
            );
          })}
        </div>
        <div className="bc-network-foot mono">
          <span>伙伴权限：已开启</span>
          <span>任务：扫描自己的代码库</span>
        </div>
      </div>
    );
  }

  if (step === 3) {
    return (
      <div className="bc-scene bc-code">
        <StatusLine step={step} />
        <div className="bc-code-head mono">
          <span>代码库扫描</span>
          <span>等级筛选：高危 + 严重</span>
          <span>结果：10,000+</span>
        </div>
        <div className="bc-code-window mono">
          {codeLines.map((line, index) => (
            <div className="bc-code-row" key={line}>
              <span>{String(index + 481).padStart(4, "0")}</span>
              <code>{line}</code>
              <i className={index % 3 === 1 ? "is-critical" : ""}>
                {index % 3 === 1 ? "严重" : "高危"}
              </i>
            </div>
          ))}
          <div className="bc-code-beam" />
        </div>
        <div className="bc-code-total">
          <span className="mono">已发现</span>
          <strong className="hero-num">10,000+</strong>
          <p>不是普通提醒，而是高危或严重级别安全漏洞</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bc-scene bc-queue">
      <StatusLine step={step} />
      <div className="bc-queue-heading">
        <span className="mono">瓶颈转移</span>
        <h2>找洞之后，<br />真正麻烦才开始</h2>
      </div>
      <div className="bc-pipeline">
        {repairStages.map((stage, index) => (
          <div
            className={`bc-pipe-stage ${index === 0 ? "is-fast" : ""}`}
            key={stage}
            style={{ "--i": index } as CSSProperties}
          >
            <span className="mono">0{index + 1}</span>
            <strong>{stage}</strong>
            <em>{repairStagesZh[index]}</em>
            <div className="bc-pipe-load">
              {Array.from({ length: index === 0 ? 3 : 8 }, (_, item) => (
                <i key={item} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="bc-queue-message mono">
        <span>发现速度</span>
        <strong>↑</strong>
        <span>修复产能</span>
        <strong>?</strong>
      </div>
    </div>
  );
}
