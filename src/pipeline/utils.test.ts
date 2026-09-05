import assert from "node:assert/strict";
import test from "node:test";
import { chatCompletionCompatibility } from "./utils";

test("NVIDIA Nemotron 3 chat requests disable thinking output", () => {
  assert.deepEqual(chatCompletionCompatibility("nvidia/nemotron-3.5-lightning-30b-a3b"), {
    chat_template_kwargs: { enable_thinking: false },
  });
});

test("other chat models do not receive NVIDIA-specific options", () => {
  assert.deepEqual(chatCompletionCompatibility("gpt-4.1-mini"), {});
});
