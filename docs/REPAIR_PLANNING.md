# Utility-based repair planning

Quality gates no longer choose the first action from a fixed priority list. Each blocking issue produces one or more `RepairCandidate` values containing:

- `expectedSuccess`: the action prior adjusted by evidence and repeated attempts;
- `estimatedCost`: normalized relative compute/API cost from `0` to `1`;
- `estimatedDurationMs`: expected wall-clock duration;
- `affectedScenes`: scenes that must be regenerated, not aggregate concat/remux scope;
- `risk`: probability and blast-radius proxy for introducing new defects;
- `evidenceConfidence`: confidence reported by FFprobe, ASR, OCR, or another gate;
- `dirtyPlan`: the exact audio, video, concat, and mux operations;
- `utility`: the deterministic score used for selection.

The objective is:

```text
expectedSuccess * evidenceConfidence
- costWeight * estimatedCost
- latencyWeight * normalizedDuration
- riskWeight * (risk + affectedScopePenalty)
```

Weights default to `0.28`, `0.18`, and `0.24`. They can be tuned with `REPAIR_COST_WEIGHT`, `REPAIR_LATENCY_WEIGHT`, and `REPAIR_RISK_WEIGHT`. Candidates, scores, reasons, weights, and the selected action are stored in `dist/runs/<run-id>/run.json` and copied into the final quality report.

## Duration drift routing

`video_project_duration_drift` is diagnosed from FFprobe evidence instead of escalating only because the attempt number increased:

1. `likelySource=mux`: choose `remux` first and preserve scene media.
2. `likelySource=concat`: choose `reconcat-video`, reuse scene caches, rebuild the silent timeline, then mux.
3. `invalidSceneIndexes` present: add a `rerender-scenes` candidate limited to those scenes.
4. Without scene-file evidence, the planner does not create a full-scene rerender candidate.

For HTML Video runs, the video gate probes every cached scene MP4 and `video-no-audio.mp4`. Scene duration errors produce `invalidSceneIndexes`; valid scenes with an invalid silent timeline produce `likelySource=concat`; a valid silent timeline with a drifting final file produces `likelySource=mux`. This makes the routing operational rather than relying on manually supplied evidence.

Repeated attempts reduce the expected success of the action that already failed, but attempt count is only one feature. Evidence, scope, cost, latency, and risk still determine the final action.

## Maintenance

Action priors live in `src/harness/retry-policy.ts`. Keep them normalized and update them with measured run data rather than adding another fixed priority list. New issue codes should define the smallest `DirtyPlan`; only add alternative candidates when the quality gate can provide evidence that distinguishes the failure layer.
