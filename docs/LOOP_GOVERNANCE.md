# Loop governance

The harness stores a run-scoped strategy trajectory at `dist/runs/<run-id>/loop/strategy-trajectory.json`. Each entry records the prompt strategy, template and variant, provider, repair action, affected scenes, issue evidence fingerprint, outcome, and the observed historical success rate for the same strategy and issue family.

No-progress now requires all of the following to remain stable across two rounds:

- project or audio generation hash;
- issue code, severity, and scene scope;
- structured issue evidence;
- quality score within the configured tolerance.

When no progress is confirmed, the planner selects the next applicable strategy rather than immediately stopping:

1. add evidence-specific local constraints;
2. use the counterexample-first revision prompt;
3. exclude the failed HTML template/variant and rerank;
4. switch to a configured fallback provider;
5. widen the dirty scope;
6. perform global replanning;
7. write the trajectory and require human confirmation.

Inapplicable steps are skipped. For example, audio repair does not attempt a template change, while video repair does not invoke an LLM revision prompt.

## Provider fallbacks

- Revision LLM: `REVISION_LLM_FALLBACK_API_KEY`, `REVISION_LLM_FALLBACK_BASE_URL`, `REVISION_LLM_FALLBACK_MODEL`.
- TTS: `TTS_PROVIDER_FALLBACK=openai|f5|local`.

## Budgets

The current budget status is written to `dist/runs/<run-id>/loop/budget-status.json`. A repair is stopped for human confirmation when any limit is reached:

- `--max-llm-tokens` / `HARNESS_MAX_LLM_TOKENS`, default `120000`;
- `--max-tts-rebuilds` / `HARNESS_MAX_TTS_REBUILDS`, default `20` scene segments;
- `--max-render-minutes` / `HARNESS_MAX_RENDER_MINUTES`, default `30`;
- `--max-estimated-cost` / `HARNESS_MAX_ESTIMATED_COST`, default `5` normalized repair-cost units;
- `--max-issue-repairs` / `HARNESS_MAX_ISSUE_REPAIRS`, default `3` attempts per issue code.

The final report includes both the strategy trajectory and the latest budget snapshot. Resume reuses the same trajectory, so a restarted run does not repeat strategies that already failed.
