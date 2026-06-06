interface ConnectorLineProps {
  className?: string;
  direction?: "vertical" | "horizontal";
}

export function ConnectorLine({ className, direction = "vertical" }: ConnectorLineProps) {
  return (
    <i
      aria-hidden="true"
      className={["visual-connector-line", `visual-connector-${direction}`, className]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
