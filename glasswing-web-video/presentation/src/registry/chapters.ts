import { createElement } from "react";
import type { ChapterDef } from "./types";
import { NewsChapter } from "../chapters/url-news/NewsChapter";
import { NEWS_STORY } from "../chapters/url-news/story-data";

export const CHAPTERS: ChapterDef[] = NEWS_STORY.chapters.map((chapter, chapterIndex) => ({
  id: chapter.id,
  title: chapter.title,
  narrations: chapter.steps.map((step) => step.narration),
  Component: ({ step }) => createElement(NewsChapter, { chapterIndex, step }),
}));
