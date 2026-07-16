# Protocol schemas

Scene Gen treats schemas as executable protocol definitions rather than parallel TypeScript interfaces.

## Quality issues

`src/harness/issue-registry.ts` is the canonical registry for issue codes. Each entry declares its default issue class, repair action, retryability, and evidence schema. Shared primitive schemas live in `src/harness/protocol-primitives.ts`, while `QualityIssue`, `StageIssue`, and journal stage issues are inferred from the same Zod schema.

To add an issue:

1. Add one entry to `issueRegistry`.
2. Use a dedicated evidence schema when the issue carries structured evidence.
3. Add routing or quality logic that emits the registered code.
4. Add a focused protocol test.

Untrusted LLM and legacy inputs may contain unknown strings. Boundary normalization maps them to `unregistered_issue` and stores the original value in `evidence.originalCode`. Canonical in-memory and persisted issues reject arbitrary codes.

## F5 worker protocol

`config/protocols/f5-worker.schema.json` is the canonical JSON Lines protocol shared by Node.js and Python. Do not edit generated files directly:

- `src/pipeline/generated/f5-worker-protocol.ts`
- `scripts/generated/f5_worker_protocol.py`

After changing the JSON Schema, regenerate and verify the checked-in outputs:

```powershell
npm run generate:protocols
npm run test:protocols
```

`npm run test:ci` includes the stale-generation check, so protocol changes cannot update only one language implementation.
