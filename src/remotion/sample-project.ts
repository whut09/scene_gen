import type { VideoProject } from "../pipeline/types";

export const sampleProject: VideoProject = {
  meta: {
    title: "AI 今日热点",
    createdAt: new Date().toISOString(),
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 62,
    sourceCount: 3,
  },
  narration: "今天的 AI 信号正在加速。程序化视频把热点拆成图表、时间线、界面和工作流。",
  scenes: [
    {
      type: "title",
      duration: 7,
      kicker: "AI NEWS RADAR",
      headline: "AI 今日热点",
      subhead: "自动抓取热点，生成可视化短视频",
      sources: ["OpenAI", "GitHub", "Hacker News"],
    },
    {
      type: "flow",
      duration: 12,
      headline: "程序化视频流水线",
      steps: [
        { label: "Hotspot", detail: "RSS / GitHub / Webpage" },
        { label: "Script", detail: "LLM 生成镜头脚本" },
        { label: "Scene JSON", detail: "组件化画面协议" },
        { label: "Render", detail: "Remotion + TTS + FFmpeg" },
      ],
    },
    {
      type: "outro",
      duration: 8,
      headline: "结论",
      bullets: ["信息密度", "更新速度", "系列感"],
    },
  ],
  sources: [],
};
