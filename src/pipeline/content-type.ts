import type { ContentType, HotItem } from "./types";

const technicalArticleUrlPatterns = [
  /cloud\.tencent\.com\/developer\/article\//i,
  /developer\.aliyun\.com\/article\//i,
  /juejin\.cn\/post\//i,
  /blog\.csdn\.net\//i,
  /cnblogs\.com\//i,
  /\/docs?\//i,
  /\/blog\//i,
  /\/tutorials?\//i,
];

const technicalArticleCues = /\u6559\u7a0b|\u5b9e\u6218|\u6e90\u7801|\u4ee3\u7801|\u7b97\u6cd5|\u67b6\u6784|\u5f00\u53d1|\u6307\u5357|\u672c\u6587|\u6b65\u9aa4|\u539f\u7406|\u63a8\u5bfc|\u8ba1\u7b97|\u51fd\u6570|\u6570\u636e\u7ed3\u6784|\u90e8\u7f72|\u8c03\u8bd5/u;

export function classifyWebpageContent(url: string, title = "", content = ""): ContentType {
  if (/github\.com\//i.test(url)) return "repository";
  if (technicalArticleUrlPatterns.some((pattern) => pattern.test(url))) return "technical-article";
  const sample = `${title} ${content}`.slice(0, 2400);
  const cueCount = [...sample.matchAll(new RegExp(technicalArticleCues.source, "gu"))].length;
  return cueCount >= 3 ? "technical-article" : "news";
}

export function contentTypeForItem(item: HotItem): ContentType {
  if (item.contentType) return item.contentType;
  if (item.kind === "github") return "repository";
  if (item.kind === "webpage") return classifyWebpageContent(item.url, item.title, `${item.summary} ${item.content ?? ""}`);
  return "news";
}
