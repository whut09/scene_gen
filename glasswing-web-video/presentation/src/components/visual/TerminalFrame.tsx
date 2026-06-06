import type { ReactNode } from "react";

interface TerminalFrameProps {
  children: ReactNode;
  className?: string;
  label?: string;
  status?: string;
}

export function TerminalFrame({ children, className, label, status }: TerminalFrameProps) {
  return (
    <section className={["visual-terminal-frame", className].filter(Boolean).join(" ")}>
      {(label || status) && (
        <header className="visual-terminal-header mono">
          <span>{label}</span>
          <span>{status}</span>
        </header>
      )}
      <div className="visual-terminal-body">{children}</div>
    </section>
  );
}
