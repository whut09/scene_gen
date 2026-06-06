import "./AutoStartGate.css";

interface Props {
  visible: boolean;
  onStart(): void;
}

/**
 * Full-screen overlay shown ONCE when `?auto=1` is loaded. Browsers block
 * audio playback until the page receives a user gesture, so we show this
 * gate and let the user press Space (or click) to release auto playback.
 *
 * After the user starts, the gate is hidden for the rest of the session.
 */
export function AutoStartGate({ visible, onStart }: Props) {
  if (!visible) return null;
  return (
    <div
      className="auto-gate"
      data-no-advance
      onClick={onStart}
      role="button"
      tabIndex={0}
    >
      <div className="auto-gate-card">
        <div className="auto-gate-kicker">自动播放</div>
        <div className="auto-gate-title">按空格开始</div>
        <div className="auto-gate-sub">
          每一屏会播放对应配音，并在结束后自动推进。
          <br />
          录屏前点击这里或按空格即可开始。
        </div>
      </div>
    </div>
  );
}
