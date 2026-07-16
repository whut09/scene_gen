import type { QualityIssue } from "../quality";

export function affectedVideoScenes(repairIndexes: number[], issues: QualityIssue[]) {
  return repairIndexes.length
    ? repairIndexes
    : [...new Set(issues.map((issue) => issue.sceneIndex).filter((value): value is number => typeof value === "number"))];
}

export function addTemplateExclusions(current: Record<string, string[]>, selections: Array<{ sceneIndex: number; templateId: string; variantId: string }>) {
  for (const selection of selections) {
    const key = String(selection.sceneIndex);
    current[key] = [...new Set([...(current[key] ?? []), `${selection.templateId}:${selection.variantId}`])];
  }
  return current;
}
