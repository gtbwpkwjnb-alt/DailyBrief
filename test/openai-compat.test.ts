import assert from "node:assert/strict";
import test from "node:test";
import { inspectOpenAICompletion } from "../lib/ai/backends/openai-compat";
import { classifyError } from "../lib/ai/log";

test("OpenAI-compatible completion exposes output-limit telemetry without response text", () => {
  const metadata = inspectOpenAICompletion({
    choices: [{
      finish_reason: "length",
      message: { content: "partial visible response" },
    }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 8192,
      total_tokens: 8312,
    },
  });

  assert.equal(metadata.finishReason, "length");
  assert.equal(metadata.outputLimited, true);
  assert.equal(metadata.visibleOutputChars, 24);
  assert.deepEqual(metadata.usage, {
    promptTokens: 120,
    completionTokens: 8192,
    totalTokens: 8312,
  });
  assert.equal(classifyError("LLM_OUTPUT_LIMIT finish_reason=length"), "output_limit");
});

test("OpenAI-compatible stop completion is not classified as output-limited", () => {
  const metadata = inspectOpenAICompletion({
    choices: [{ finish_reason: "stop", message: { content: "complete" } }],
  });

  assert.equal(metadata.outputLimited, false);
  assert.equal(metadata.visibleOutputChars, 8);
  assert.equal(metadata.usage, null);
});
