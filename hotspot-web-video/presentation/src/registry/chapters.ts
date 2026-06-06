import type { ChapterDef } from "./types";
import Coldopen from "../chapters/01-coldopen/Coldopen";
import { narrations as coldopenNarrations } from "../chapters/01-coldopen/narrations";
import Heat from "../chapters/02-heat/Heat";
import { narrations as heatNarrations } from "../chapters/02-heat/narrations";
import PressureTest from "../chapters/03-pressure-test/PressureTest";
import { narrations as pressureNarrations } from "../chapters/03-pressure-test/narrations";

export const CHAPTERS: ChapterDef[] = [
  {
    id: "coldopen",
    title: "这不是普通融资新闻",
    narrations: coldopenNarrations,
    Component: Coldopen,
  },
  {
    id: "heat",
    title: "为什么这条在技术圈炸了",
    narrations: heatNarrations,
    Component: Heat,
  },
  {
    id: "pressure-test",
    title: "AI 热潮进入压力测试",
    narrations: pressureNarrations,
    Component: PressureTest,
  },
];
