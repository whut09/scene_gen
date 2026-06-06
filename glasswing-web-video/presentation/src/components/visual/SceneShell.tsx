import type { ReactNode } from "react";

type SceneTone = "terminal" | "terminal-bright";

interface SceneShellProps {
  children: ReactNode;
  className?: string;
  tone?: SceneTone;
}

export function SceneShell({ children, className, tone = "terminal-bright" }: SceneShellProps) {
  return (
    <section className={["visual-scene-shell", className].filter(Boolean).join(" ")} data-tone={tone}>
      {children}
    </section>
  );
}
