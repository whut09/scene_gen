import type { CSSProperties } from "react";

interface GlowGridProps {
  cells?: number;
  className?: string;
}

export function GlowGrid({ cells = 64, className }: GlowGridProps) {
  return (
    <div className={["visual-glow-grid", className].filter(Boolean).join(" ")} aria-hidden="true">
      {Array.from({ length: cells }, (_, index) => (
        <i key={index} style={{ "--i": index } as CSSProperties} />
      ))}
    </div>
  );
}
