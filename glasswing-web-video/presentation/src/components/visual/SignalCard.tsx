import type { ReactNode } from "react";

interface SignalCardProps {
  accent?: boolean;
  children: ReactNode;
  className?: string;
}

export function SignalCard({ accent = false, children, className }: SignalCardProps) {
  return (
    <article
      className={[
        "visual-signal-card",
        accent ? "visual-signal-card-accent" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </article>
  );
}
