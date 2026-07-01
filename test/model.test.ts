import { expect, test, vi } from "vitest";
import { z } from "zod";
import { AnthropicProvider } from "../src/model/anthropic.js";
import { BudgetExceededError } from "../src/model/provider.js";

const schema = z.object({ answer: z.string() });

function fakeClient(replies: string[], inputTokens = 1000, outputTokens = 100) {
  let call = 0;
  const create = vi.fn(async () => ({
    content: [{ type: "text", text: replies[Math.min(call++, replies.length - 1)] }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }));
  return { client: { messages: { create } }, create };
}

test("complete returns schema-validated JSON", async () => {
  const { client } = fakeClient(['{"answer":"yes"}']);
  const p = new AnthropicProvider({ maxBudgetUsd: 10 }, client as never);
  expect(await p.complete({ prompt: "q", schema })).toEqual({ answer: "yes" });
  expect(p.spentUsd()).toBeGreaterThan(0);
});

test("extracts JSON from surrounding prose", async () => {
  const { client } = fakeClient(['Sure! Here you go:\n{"answer":"yes"}\nHope that helps.']);
  const p = new AnthropicProvider({ maxBudgetUsd: 10 }, client as never);
  expect(await p.complete({ prompt: "q", schema })).toEqual({ answer: "yes" });
});

test("retries once on invalid output, feeding the validation error back", async () => {
  const { client, create } = fakeClient(['{"wrong":true}', '{"answer":"fixed"}']);
  const p = new AnthropicProvider({ maxBudgetUsd: 10 }, client as never);
  expect(await p.complete({ prompt: "q", schema })).toEqual({ answer: "fixed" });
  expect(create).toHaveBeenCalledTimes(2);
  const retryPrompt = create.mock.calls[1]![0].messages[0].content as string;
  expect(retryPrompt).toContain("invalid");
});

test("fails after two invalid attempts", async () => {
  const { client } = fakeClient(["not json at all"]);
  const p = new AnthropicProvider({ maxBudgetUsd: 10 }, client as never);
  await expect(p.complete({ prompt: "q", schema })).rejects.toThrow(/schema validation/);
});

test("throws BudgetExceededError once spend crosses the cap, before calling the API", async () => {
  // huge token usage so one call blows a tiny budget
  const { client, create } = fakeClient(['{"answer":"a"}'], 10_000_000, 1_000_000);
  const p = new AnthropicProvider({ maxBudgetUsd: 0.01 }, client as never);
  await p.complete({ prompt: "q", schema }); // first call allowed, records spend
  await expect(p.complete({ prompt: "q", schema })).rejects.toThrow(BudgetExceededError);
  expect(create).toHaveBeenCalledTimes(1);
});

test("extracts JSON when trailing prose contains its own braces", async () => {
  const { client } = fakeClient([
    'Here\'s the JSON: {"answer":"yes"}. Does this format {like that} help?',
  ]);
  const p = new AnthropicProvider({ maxBudgetUsd: 10 }, client as never);
  expect(await p.complete({ prompt: "q", schema })).toEqual({ answer: "yes" });
});

test("extracts a bare JSON array wrapped in prose", async () => {
  const arraySchema = z.array(z.string());
  const { client } = fakeClient(['Sure, here: ["a", "b"] enjoy!']);
  const p = new AnthropicProvider({ maxBudgetUsd: 10 }, client as never);
  expect(await p.complete({ prompt: "q", schema: arraySchema })).toEqual(["a", "b"]);
});

test("extracts JSON when a string value contains a closing brace", async () => {
  const { client } = fakeClient(['prefix noise {"answer":"a}b"} suffix noise']);
  const p = new AnthropicProvider({ maxBudgetUsd: 10 }, client as never);
  expect(await p.complete({ prompt: "q", schema })).toEqual({ answer: "a}b" });
});

test("constructor throws for a model with no price data", () => {
  const { client } = fakeClient(['{"answer":"a"}']);
  expect(
    () => new AnthropicProvider({ model: "claude-nonexistent", maxBudgetUsd: 10 }, client as never),
  ).toThrow(/no price data/);
});
