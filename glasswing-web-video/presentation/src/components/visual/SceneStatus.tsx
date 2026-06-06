interface SceneStatusProps {
  center: string;
  className?: string;
  left: string;
  right: string;
}

export function SceneStatus({ center, className, left, right }: SceneStatusProps) {
  return (
    <div className={["visual-scene-status mono", className].filter(Boolean).join(" ")}>
      <span>{left}</span>
      <span>{center}</span>
      <span>{right}</span>
    </div>
  );
}
