import { expect, test, vi } from "vitest";
import { z } from "zod";
import { OpenAICompatibleProvider } from "../src/model/openai-compatible.js";
import { BudgetExceededError } from "../src/model/provider.js";
import { OpenAICompatibleProvider as _P, RateLimitError, retryAfterMs } from "../src/model/openai-compatible.js";

const schema = z.object({ answer: z.string() });

// Builds a fake `fetch` that returns each canned body in order (last one sticks),
// as a real Response so `.ok`, `.status`, `.headers`, `.json()`, `.text()` all work.
function fakeFetch(bodies: unknown[], usage = { prompt_tokens: 1000, completion_tokens: 100 }) {
  let call = 0;
  const fn = vi.fn(async () => {
    const content = bodies[Math.min(call++, bodies.length - 1)];
    const payload = { choices: [{ message: { content } }], usage };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  });
  return fn;
}

function makeProvider(fetchFn: typeof fetch, opts: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  return new OpenAICompatibleProvider(
    { baseUrl: "https://x/inference", apiKey: "tok", model: "m", maxBudgetUsd: 10, ...opts },
    fetchFn,
  );
}

test("complete returns schema-validated JSON from choices[0].message.content", async () => {
  const p = makeProvider(fakeFetch(['{"answer":"yes"}']));
  expect(await p.complete({ prompt: "q", schema })).toEqual({ answer: "yes" });
});

test("extracts JSON from surrounding prose", async () => {
  const p = makeProvider(fakeFetch(['Sure!\n{"answer":"yes"}\nHope that helps.']));
  expect(await p.complete({ prompt: "q", schema })).toEqual({ answer: "yes" });
});

test("retries once on invalid output, feeding the validation error back", async () => {
  const fn = fakeFetch(['{"wrong":true}', '{"answer":"fixed"}']);
  const p = makeProvider(fn);
  expect(await p.complete({ prompt: "q", schema })).toEqual({ answer: "fixed" });
  expect(fn).toHaveBeenCalledTimes(2);
  const secondBody = JSON.parse((fn.mock.calls[1]![1] as RequestInit).body as string);
  expect(secondBody.messages.at(-1).content).toContain("invalid");
});

test("fails after two invalid attempts", async () => {
  const p = makeProvider(fakeFetch(["not json at all"]));
  await expect(p.complete({ prompt: "q", schema })).rejects.toThrow(/schema validation/);
});

test("sends Authorization header when apiKey set, omits it when not", async () => {
  const withKey = fakeFetch(['{"answer":"a"}']);
  await makeProvider(withKey, { apiKey: "tok" }).complete({ prompt: "q", schema });
  expect(((withKey.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer tok");

  const noKey = fakeFetch(['{"answer":"a"}']);
  await makeProvider(noKey, { apiKey: undefined }).complete({ prompt: "q", schema });
  expect(((noKey.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).authorization).toBeUndefined();
});

test("includes a system message only when system is provided", async () => {
  const withSys = fakeFetch(['{"answer":"a"}']);
  await makeProvider(withSys).complete({ prompt: "q", schema, system: "be terse" });
  const body = JSON.parse((withSys.mock.calls[0]![1] as RequestInit).body as string);
  expect(body.messages[0]).toEqual({ role: "system", content: "be terse" });
  expect(body.messages.at(-1).role).toBe("user");
});

test("books cost only when pricePerMTok is known; else $0 with a one-time onWarn", async () => {
  const priced = makeProvider(fakeFetch(['{"answer":"a"}']), { pricePerMTok: { input: 1, output: 1 } });
  await priced.complete({ prompt: "q", schema });
  expect(priced.spentUsd()).toBeGreaterThan(0);

  const onWarn = vi.fn();
  const free = makeProvider(fakeFetch(['{"answer":"a"}', '{"answer":"b"}']), { pricePerMTok: undefined, onWarn });
  await free.complete({ prompt: "q", schema });
  await free.complete({ prompt: "q", schema });
  expect(free.spentUsd()).toBe(0);
  expect(onWarn).toHaveBeenCalledTimes(1); // one-time, not per-call
});

test("tolerates a missing usage object (books nothing, does not throw)", async () => {
  let call = 0;
  const fn = vi.fn(async () => {
    call++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"a"}' } }] }), { status: 200 });
  });
  const p = makeProvider(fn as unknown as typeof fetch, { pricePerMTok: { input: 1, output: 1 } });
  expect(await p.complete({ prompt: "q", schema })).toEqual({ answer: "a" });
  expect(p.spentUsd()).toBe(0);
});

test("throws BudgetExceededError once spend crosses the cap, before the next call", async () => {
  const fn = fakeFetch(['{"answer":"a"}'], { prompt_tokens: 10_000_000, completion_tokens: 1_000_000 });
  const p = makeProvider(fn, { maxBudgetUsd: 0.01, pricePerMTok: { input: 3, output: 15 } });
  await p.complete({ prompt: "q", schema });
  await expect(p.complete({ prompt: "q", schema })).rejects.toThrow(BudgetExceededError);
  expect(fn).toHaveBeenCalledTimes(1);
});

// A fetch that returns `statuses` in order (each a status code); 200s carry a valid body.
function statusFetch(statuses: number[], headers: Record<string, string> = {}) {
  let call = 0;
  return vi.fn(async () => {
    const status = statuses[Math.min(call++, statuses.length - 1)]!;
    if (status === 200) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }], usage: {} }), { status: 200 });
    }
    return new Response("rate limited", { status, headers });
  });
}

test("retries on 429 (no real sleep) then succeeds", async () => {
  const sleep = vi.fn(async () => {});
  const fn = statusFetch([429, 200], { "retry-after": "1" });
  const p = new OpenAICompatibleProvider(
    { baseUrl: "https://x/inference", apiKey: "t", model: "m", maxBudgetUsd: 10, sleep },
    fn as unknown as typeof fetch,
  );
  expect(await p.complete({ prompt: "q", schema })).toEqual({ answer: "ok" });
  expect(fn).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(1000);
});

test("throws RateLimitError with actionable guidance after retries are exhausted", async () => {
  const sleep = vi.fn(async () => {});
  const fn = statusFetch([429]);
  const p = new OpenAICompatibleProvider(
    { baseUrl: "https://x/inference", apiKey: "t", model: "m", maxBudgetUsd: 10, sleep, maxRateLimitRetries: 2 },
    fn as unknown as typeof fetch,
  );
  await expect(p.complete({ prompt: "q", schema })).rejects.toThrow(RateLimitError);
  await expect(p.complete({ prompt: "q", schema })).rejects.toThrow(/ollama|ANTHROPIC_API_KEY/);
});

test("non-429 non-2xx throws with status and body excerpt", async () => {
  const fn = statusFetch([500]);
  const p = new OpenAICompatibleProvider(
    { baseUrl: "https://x/inference", apiKey: "t", model: "m", maxBudgetUsd: 10 },
    fn as unknown as typeof fetch,
  );
  await expect(p.complete({ prompt: "q", schema })).rejects.toThrow(/500/);
});

test("retryAfterMs reads Retry-After seconds, caps it, and defaults to 1000", () => {
  expect(retryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2000);
  expect(retryAfterMs(new Headers({ "retry-after": "9999" }))).toBe(60_000); // capped
  expect(retryAfterMs(new Headers({}))).toBe(1000); // default
});
