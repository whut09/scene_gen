import React from "react";
import { AbsoluteFill, Audio, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { VideoScene } from "../pipeline/types";
import type { ProjectProps } from "./index";
import "./styles.css";

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const ease = (value: number) => 1 - Math.pow(1 - clamp(value), 3);

function SceneFrame({
  children,
  title,
  localFrame,
}: {
  children: React.ReactNode;
  title: string;
  localFrame: number;
}) {
  const intro = ease(localFrame / 20);
  return (
    <AbsoluteFill className="scene">
      <div className="gridGlow" />
      <div className="scanline" style={{ transform: `translateY(${(localFrame * 3) % 900}px)` }} />
      <header className="topbar">
        <div className="brandMark">SG</div>
        <div>
          <div className="eyebrow">Programmatic Video</div>
          <div className="smallTitle">{title}</div>
        </div>
        <div className="livePill">AI Radar</div>
      </header>
      <main className="content" style={{ opacity: intro, transform: `translateY(${(1 - intro) * 28}px)` }}>
        {children}
      </main>
    </AbsoluteFill>
  );
}

function TitleScene({ scene, localFrame }: { scene: Extract<VideoScene, { type: "title" }>; localFrame: number }) {
  const pulse = Math.sin(localFrame / 13) * 0.5 + 0.5;
  return (
    <SceneFrame title={scene.kicker} localFrame={localFrame}>
      <section className="hero">
        <div className="radar" style={{ transform: `rotate(${localFrame * 0.8}deg)` }}>
          <span />
          <span />
          <span />
        </div>
        <div className="kicker">{scene.kicker}</div>
        <h1>{scene.headline}</h1>
        <p>{scene.subhead}</p>
        <div className="sourceRow">
          {scene.sources.map((source, index) => (
            <div className="sourceChip" key={source} style={{ opacity: 0.62 + pulse * 0.38 }}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              {source}
            </div>
          ))}
        </div>
      </section>
    </SceneFrame>
  );
}

function NewsStack({
  scene,
  localFrame,
}: {
  scene: Extract<VideoScene, { type: "news_stack" }>;
  localFrame: number;
}) {
  return (
    <SceneFrame title={scene.headline} localFrame={localFrame}>
      <div className="sectionTitle">{scene.headline}</div>
      <div className="newsStack">
        {scene.items.map((item, index) => {
          const reveal = ease((localFrame - index * 18) / 22);
          return (
            <article
              className="newsCard"
              key={item.url}
              style={{ opacity: reveal, transform: `translateX(${(1 - reveal) * 80}px)` }}
            >
              <div className="rank">{index + 1}</div>
              <div>
                <div className="cardMeta">{item.source}</div>
                <h2>{item.title}</h2>
                <p>{item.summary}</p>
                <div className="tagRow">
                  {item.tags.slice(0, 3).map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </SceneFrame>
  );
}

function BriefingPoints({
  scene,
  localFrame,
}: {
  scene: Extract<VideoScene, { type: "briefing_points" }>;
  localFrame: number;
}) {
  return (
    <SceneFrame title={scene.headline} localFrame={localFrame}>
      <div className="briefing">
        <div className="sectionTitle">{scene.headline}</div>
        <article className="briefHero">
          <div className="cardMeta">{scene.source}</div>
          <h2>{scene.title}</h2>
          <p>{scene.summary}</p>
        </article>
        <div className="metricStrip">
          {scene.metrics.map((metric, index) => (
            <div className="metricBox" key={`${metric.label}-${index}`}>
              <span>{metric.label}</span>
              <b>{metric.value}</b>
            </div>
          ))}
        </div>
        <div className="pointList">
          {scene.points.map((point, index) => {
            const reveal = ease((localFrame - index * 15) / 24);
            return (
              <div
                className="pointItem"
                key={point}
                style={{ opacity: reveal, transform: `translateY(${(1 - reveal) * 24}px)` }}
              >
                <span>{index + 1}</span>
                <p>{point}</p>
              </div>
            );
          })}
        </div>
      </div>
    </SceneFrame>
  );
}

function SignalChart({
  scene,
  localFrame,
}: {
  scene: Extract<VideoScene, { type: "signal_chart" }>;
  localFrame: number;
}) {
  return (
    <SceneFrame title={scene.headline} localFrame={localFrame}>
      <div className="sectionTitle">{scene.headline}</div>
      <div className="chart">
        {scene.bars.map((bar, index) => {
          const progress = ease((localFrame - index * 8) / 38);
          return (
            <div className="barRow" key={bar.label}>
              <div className="barHead">
                <span>{bar.label}</span>
                <b>{Math.round(bar.value * progress)}</b>
              </div>
              <div className="barTrack">
                <div
                  className="barFill"
                  style={{
                    width: `${bar.value * progress}%`,
                    background: `linear-gradient(90deg, ${bar.color}, #ffffff)`,
                  }}
                />
              </div>
              <div className="barDetail">{bar.detail}</div>
            </div>
          );
        })}
      </div>
    </SceneFrame>
  );
}

function WebScreenshotZoom({
  scene,
  localFrame,
}: {
  scene: Extract<VideoScene, { type: "web_screenshot_zoom" }>;
  localFrame: number;
}) {
  const { fps } = useVideoConfig();
  const framesPerShot = Math.max(1, Math.round((scene.duration * fps) / Math.max(1, scene.shots.length)));
  const shotIndex = Math.min(scene.shots.length - 1, Math.floor(localFrame / framesPerShot));
  const shot = scene.shots[shotIndex];
  const shotFrame = localFrame - shotIndex * framesPerShot;
  const progress = ease(shotFrame / framesPerShot);
  const imageScale = 1.02 + progress * 0.12;
  const focusX = (shot.highlight.x + shot.highlight.width / 2) / shot.width - 0.5;
  const focusY = (shot.highlight.y + shot.highlight.height / 2) / shot.height - 0.5;
  const translateX = -focusX * 120 * progress;
  const translateY = -focusY * 180 * progress;

  return (
    <SceneFrame title={scene.headline} localFrame={localFrame}>
      <div className="screenshotScene">
        <div className="sectionTitle">{scene.headline}</div>
        <div className="browserShell">
          <div className="browserBar">
            <div className="traffic">
              <span />
              <span />
              <span />
            </div>
            <div className="address">{new URL(shot.url).hostname.replace(/^www\./, "")}</div>
          </div>
          <div className="shotViewport">
            <div
              className="shotCanvas"
              style={{
                transform: `translate(${translateX}px, ${translateY}px) scale(${imageScale})`,
              }}
            >
              <Img className="webShot" src={staticFile(shot.src.replace(/^\//, ""))} />
              <div
                className="focusBox"
                style={{
                  left: `${(shot.highlight.x / shot.width) * 100}%`,
                  top: `${(shot.highlight.y / shot.height) * 100}%`,
                  width: `${(shot.highlight.width / shot.width) * 100}%`,
                  height: `${(shot.highlight.height / shot.height) * 100}%`,
                  transform: `scale(${1 + Math.sin(localFrame / 9) * 0.015})`,
                }}
              />
            </div>
            <div className="glassSweep" style={{ transform: `translateX(${progress * 980 - 180}px)` }} />
          </div>
        </div>
        <div className="shotCaption">
          <b>{shot.source}</b>
          <span>{shot.title}</span>
        </div>
      </div>
    </SceneFrame>
  );
}

function Timeline({ scene, localFrame }: { scene: Extract<VideoScene, { type: "timeline" }>; localFrame: number }) {
  return (
    <SceneFrame title={scene.headline} localFrame={localFrame}>
      <div className="sectionTitle">{scene.headline}</div>
      <div className="timeline">
        <div className="timelineLine" style={{ height: `${ease(localFrame / 80) * 100}%` }} />
        {scene.events.map((event, index) => {
          const reveal = ease((localFrame - index * 16) / 24);
          return (
            <div className="timelineEvent" key={`${event.date}-${event.title}`} style={{ opacity: reveal }}>
              <div className="dot" />
              <div className="time">{event.date}</div>
              <div>
                <h2>{event.title}</h2>
                <p>{event.source}</p>
              </div>
            </div>
          );
        })}
      </div>
    </SceneFrame>
  );
}

function GithubPulse({
  scene,
  localFrame,
}: {
  scene: Extract<VideoScene, { type: "github_pulse" }>;
  localFrame: number;
}) {
  return (
    <SceneFrame title={scene.headline} localFrame={localFrame}>
      <div className="sectionTitle">{scene.headline}</div>
      <div className="repoGrid">
        {scene.repos.map((repo, index) => {
          const wave = Math.sin((localFrame + index * 14) / 11) * 0.5 + 0.5;
          return (
            <article className="repoCard" key={repo.repo}>
              <div className="repoIcon" style={{ boxShadow: `0 0 ${24 + wave * 38}px rgba(66,211,146,.55)` }}>
                {"</>"}
              </div>
              <h2>{repo.repo}</h2>
              <h3>{repo.title}</h3>
              <p>{repo.summary}</p>
              <div className="repoScore">{repo.score}</div>
            </article>
          );
        })}
      </div>
    </SceneFrame>
  );
}

function FlowScene({ scene, localFrame }: { scene: Extract<VideoScene, { type: "flow" }>; localFrame: number }) {
  return (
    <SceneFrame title={scene.headline} localFrame={localFrame}>
      <div className="sectionTitle">{scene.headline}</div>
      <div className="flow">
        {scene.steps.map((step, index) => {
          const active = localFrame / 22 > index;
          return (
            <React.Fragment key={step.label}>
              <div className={`flowNode ${active ? "active" : ""}`}>
                <b>{step.label}</b>
                <span>{step.detail}</span>
              </div>
              {index < scene.steps.length - 1 ? <div className={`flowEdge ${active ? "active" : ""}`} /> : null}
            </React.Fragment>
          );
        })}
      </div>
    </SceneFrame>
  );
}

function Outro({ scene, localFrame }: { scene: Extract<VideoScene, { type: "outro" }>; localFrame: number }) {
  return (
    <SceneFrame title={scene.headline} localFrame={localFrame}>
      <div className="outro">
        <h1>{scene.headline}</h1>
        {scene.bullets.map((bullet, index) => {
          const reveal = ease((localFrame - index * 18) / 26);
          return (
            <div className="takeaway" key={bullet} style={{ opacity: reveal }}>
              <span>{index + 1}</span>
              {bullet}
            </div>
          );
        })}
      </div>
    </SceneFrame>
  );
}

function SceneSwitch({ scene }: { scene: VideoScene }) {
  const frame = useCurrentFrame();
  const localFrame = frame;
  switch (scene.type) {
    case "title":
      return <TitleScene scene={scene} localFrame={localFrame} />;
    case "news_stack":
      return <NewsStack scene={scene} localFrame={localFrame} />;
    case "briefing_points":
      return <BriefingPoints scene={scene} localFrame={localFrame} />;
    case "signal_chart":
      return <SignalChart scene={scene} localFrame={localFrame} />;
    case "web_screenshot_zoom":
      return <WebScreenshotZoom scene={scene} localFrame={localFrame} />;
    case "timeline":
      return <Timeline scene={scene} localFrame={localFrame} />;
    case "github_pulse":
      return <GithubPulse scene={scene} localFrame={localFrame} />;
    case "flow":
      return <FlowScene scene={scene} localFrame={localFrame} />;
    case "outro":
      return <Outro scene={scene} localFrame={localFrame} />;
  }
}

export const VideoRoot: React.FC<ProjectProps> = ({ project }) => {
  const { fps } = useVideoConfig();
  let cursor = 0;
  const audioSrc = project.audio?.src.replace(/^\//, "");

  return (
    <AbsoluteFill className="root">
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}
      {project.scenes.map((scene, index) => {
        const start = cursor;
        const duration = Math.round(scene.duration * fps);
        cursor += duration;
        return (
          <Sequence key={`${scene.type}-${index}`} from={start} durationInFrames={duration}>
            <SceneSwitch scene={scene} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
