# OpenAI-compatible Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic OpenAI-compatible `ModelProvider` with `github-models`, `ollama`, and `openai` presets so prlore runs inside GitHub Copilot / Codespaces (via `GITHUB_TOKEN`) and gets a rate-limit-free local option (Ollama) for full mines.

**Architecture:** One new provider class (`OpenAICompatibleProvider`) reuses the existing prompt-based structured-output path (`appendSchemaHint` + `extractJson` + 2-attempt schema retry) and POSTs to any `/chat/completions` endpoint. `selectProvider` gains three preset builders that all construct it, and `auto` falls back to GitHub Models when a GitHub token is present. No change to the `anthropic` / `claude-cli` paths.

**Tech Stack:** TypeScript/Node (ESM, `.js` import specifiers), zod, vitest, global `fetch`.

## Global Constraints

- ESM imports use `.js` specifiers even for `.ts` files (e.g. `import { extractJson } from "./anthropic.js"`).
- Providers implement `ModelProvider` from `src/model/provider.ts`: `complete<T>(opts): Promise<T>` + `spentUsd(): number`.
- Structured output is prompt-based only — reuse `appendSchemaHint(text, schema)` and `extractJson(text)`. Do NOT use `response_format` / json_schema in v1.
- All network/process seams are injected via constructor params so tests never touch the network (mirrors `AnthropicProvider`'s `client` and `ClaudeCliProvider`'s `runCli`).
- Test runner is vitest: `import { expect, test, vi } from "vitest";`.
- Run the full suite with `npm test` and typecheck with `npx tsc --noEmit`; both must stay green.
- Commit messages: no `Co-Authored-By` or AI-attribution trailers.
- Default GitHub Models model is `openai/gpt-4o-mini`; default Ollama model is `qwen2.5:7b`.
- GitHub Models base URL: `https://models.github.ai/inference`. Ollama default base URL: `http://localhost:11434/v1`.

---

### Task 1: OpenAICompatibleProvider core (happy path, schema retry, cost/budget)

**Files:**
- Create: `src/model/openai-compatible.ts`
- Test: `test/openai-compatible-provider.test.ts`

**Interfaces:**
- Consumes: `extractJson` from `src/model/anthropic.ts`; `appendSchemaHint` from `src/model/schema-hint.ts`; `ModelProvider`, `CompleteOptions`, `BudgetExceededError` from `src/model/provider.ts`.
- Produces:
  - `export interface OpenAICompatibleOpts { baseUrl: string; apiKey?: string; model: string; maxBudgetUsd: number; pricePerMTok?: { input: number; output: number }; onWarn?: (msg: string) => void; maxRateLimitRetries?: number; sleep?: (ms: number) => Promise<void>; }`
  - `export class OpenAICompatibleProvider implements ModelProvider` with `constructor(opts: OpenAICompatibleOpts, fetchFn?: typeof fetch)`, `complete<T>(opts: CompleteOptions<T>): Promise<T>`, `spentUsd(): number`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/openai-compatible-provider.test.ts
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { OpenAICompatibleProvider } from "../src/model/openai-compatible.js";
import { BudgetExceededError } from "../src/model/provider.js";

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

function makeProvider(fetchFn: typeof fetch, opts: Partial<Parameters<typeof OpenAICompatibleProvider.prototype.constructor>[0]> = {}) {
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/openai-compatible-provider.test.ts`
Expected: FAIL — "Cannot find module '../src/model/openai-compatible.js'".

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/model/openai-compatible.ts
import { extractJson } from "./anthropic.js";
import { BudgetExceededError, type CompleteOptions, type ModelProvider } from "./provider.js";
import { appendSchemaHint } from "./schema-hint.js";

const BODY_EXCERPT_LEN = 300;

export interface OpenAICompatibleOpts {
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxBudgetUsd: number;
  pricePerMTok?: { input: number; output: number };
  onWarn?: (msg: string) => void;
  maxRateLimitRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}
interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: ChatUsage;
}

export class OpenAICompatibleProvider implements ModelProvider {
  private spent = 0;
  private warnedNoCost = false;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: OpenAICompatibleOpts, fetchFn: typeof fetch = fetch) {
    this.fetchFn = fetchFn;
  }

  spentUsd(): number {
    return this.spent;
  }

  async complete<T>({ system, prompt, schema, maxTokens = 4096 }: CompleteOptions<T>): Promise<T> {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.spent >= this.opts.maxBudgetUsd) {
        throw new BudgetExceededError(this.spent, this.opts.maxBudgetUsd);
      }
      const basePrompt =
        attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous reply was invalid: ${lastError}\nReply with ONLY valid JSON matching the requested shape.`;
      const content = appendSchemaHint(basePrompt, schema);
      const messages = [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content },
      ];
      const res = await this.post({ model: this.opts.model, max_tokens: maxTokens, messages });
      this.track(res.usage);
      const text = res.choices?.[0]?.message?.content ?? "";
      try {
        return schema.parse(JSON.parse(extractJson(text)));
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(`model output failed schema validation twice: ${lastError}`);
  }

  // v1: no 429 handling yet — any non-2xx throws a generic error. Task 2 layers
  // rate-limit retry/backoff on top of this method.
  private async post(body: unknown): Promise<ChatResponse> {
    const res = await this.fetchFn(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const excerpt = (await res.text()).slice(0, BODY_EXCERPT_LEN);
      throw new Error(`model endpoint returned ${res.status}: ${excerpt}`);
    }
    return (await res.json()) as ChatResponse;
  }

  private track(usage: ChatUsage | undefined): void {
    if (!this.opts.pricePerMTok) {
      if (!this.warnedNoCost) {
        this.warnedNoCost = true;
        this.opts.onWarn?.("cost tracking unavailable for this provider; --max-budget will not gate it");
      }
      return;
    }
    const inTok = usage?.prompt_tokens ?? 0;
    const outTok = usage?.completion_tokens ?? 0;
    this.spent += (inTok * this.opts.pricePerMTok.input + outTok * this.opts.pricePerMTok.output) / 1_000_000;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/openai-compatible-provider.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/model/openai-compatible.ts test/openai-compatible-provider.test.ts
git commit -m "feat: OpenAI-compatible model provider (core)"
```

---

### Task 2: Rate-limit (429) handling

**Files:**
- Modify: `src/model/openai-compatible.ts` (replace the `post` method; add `RateLimitError` and `retryAfterMs`)
- Test: `test/openai-compatible-provider.test.ts` (append cases)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `export class RateLimitError extends Error`
  - `export function retryAfterMs(headers: Headers): number`

- [ ] **Step 1: Write the failing tests (append to the existing test file)**

```ts
import { OpenAICompatibleProvider as _P, RateLimitError, retryAfterMs } from "../src/model/openai-compatible.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/openai-compatible-provider.test.ts`
Expected: FAIL — `RateLimitError`/`retryAfterMs` not exported; 429 currently throws a generic error, not `RateLimitError`.

- [ ] **Step 3: Replace the `post` method and add the exports**

Add near the top of `src/model/openai-compatible.ts` (after `BODY_EXCERPT_LEN`):

```ts
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 4;
const MAX_RETRY_AFTER_MS = 60_000;

export class RateLimitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RateLimitError";
  }
}

export function retryAfterMs(headers: Headers): number {
  const ra = headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  }
  return 1000;
}
```

Replace the entire `post` method body with:

```ts
  private async post(body: unknown): Promise<ChatResponse> {
    const maxRetries = this.opts.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let rl = 0; ; rl++) {
      const res = await this.fetchFn(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        if (rl >= maxRetries) {
          throw new RateLimitError(
            "model endpoint rate limit / daily quota exhausted. Use --provider ollama for a local unlimited run, or set ANTHROPIC_API_KEY for a full mine.",
          );
        }
        await sleep(retryAfterMs(res.headers));
        continue;
      }
      if (!res.ok) {
        const excerpt = (await res.text()).slice(0, BODY_EXCERPT_LEN);
        throw new Error(`model endpoint returned ${res.status}: ${excerpt}`);
      }
      return (await res.json()) as ChatResponse;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/openai-compatible-provider.test.ts`
Expected: PASS (Task 1 + Task 2 cases).

- [ ] **Step 5: Commit**

```bash
git add src/model/openai-compatible.ts test/openai-compatible-provider.test.ts
git commit -m "feat: 429 rate-limit retry/backoff for OpenAI-compatible provider"
```

---

### Task 3: Config schema + CLI surface

**Files:**
- Modify: `src/schemas/mine-config.ts:40-41` (provider enum + new `baseUrl`)
- Modify: `src/cli.ts` (USAGE help ~55-58, `PROVIDER_VALUES` :76, parseArgs options ~93-96, configInput.model ~169-173)
- Test: `test/cli.test.ts` (append cases)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `MineConfig["model"]` now has optional `baseUrl?: string`; `provider` enum includes `"github-models" | "ollama" | "openai"`. CLI accepts `--base-url <url>` and the new `--provider` values.

- [ ] **Step 1: Write the failing tests (append to `test/cli.test.ts`)**

`parseMineArgs` is module-private; the public entry is `runMineCli(argv, deps)`, and
tests capture the parsed+validated `MineConfig` via `ScriptedJobManager.startCalls[0].config`.
These new tests reuse the file's existing helpers (`tmpRepo`, `ScriptedJobManager`,
`readyStatus`, `mkDraft`, `mkProvenance`, `mkRule`, `streams`, `makeDeps`, `baseArgv`),
mirroring the `--author` test at the top of the file.

```ts
test("--provider openai with --base-url threads provider + baseUrl into config.model", async () => {
  const repoPath = await tmpRepo();
  const manager = new ScriptedJobManager([readyStatus()], { draft: mkDraft([]), provenance: mkProvenance([mkRule()]), contested: [] });
  const { stdout, stderr } = streams();

  const code = await runMineCli(
    baseArgv("octo/repo", repoPath, ["--provider", "openai", "--base-url", "https://api.example/v1", "--model", "gpt-x"]),
    { makeDeps, manager, stdout, stderr, confirm: async () => true, pollIntervalMs: 0 },
  );

  expect(code).toBe(0);
  expect(manager.startCalls[0]!.config.model.provider).toBe("openai");
  expect(manager.startCalls[0]!.config.model.baseUrl).toBe("https://api.example/v1");
  expect(manager.startCalls[0]!.config.model.model).toBe("gpt-x");
});

test("--provider github-models is accepted and lands in config.model.provider", async () => {
  const repoPath = await tmpRepo();
  const manager = new ScriptedJobManager([readyStatus()], { draft: mkDraft([]), provenance: mkProvenance([mkRule()]), contested: [] });
  const { stdout, stderr } = streams();

  const code = await runMineCli(baseArgv("octo/repo", repoPath, ["--provider", "github-models"]), {
    makeDeps, manager, stdout, stderr, confirm: async () => true, pollIntervalMs: 0,
  });

  expect(code).toBe(0);
  expect(manager.startCalls[0]!.config.model.provider).toBe("github-models");
});

test("an unknown --provider exits 2 and the error lists the new values", async () => {
  const repoPath = await tmpRepo();
  const manager = new ScriptedJobManager([readyStatus()]);
  const { stdout, stderr, err } = streams();

  const code = await runMineCli(baseArgv("octo/repo", repoPath, ["--provider", "nope"]), {
    makeDeps, manager, stdout, stderr, confirm: async () => true, pollIntervalMs: 0,
  });

  expect(code).toBe(2);
  expect(err()).toMatch(/github-models|ollama/);
});
```

> If `tmpRepo`, `mkDraft`, `mkProvenance`, or `mkRule` are named differently in the
> current `test/cli.test.ts`, use whatever the file's other tests already use — copy an
> existing passing test's setup lines verbatim and only change the `extra` args array.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — unknown provider currently rejected against the old list; `baseUrl` not present on config.

- [ ] **Step 3: Update the config schema**

In `src/schemas/mine-config.ts`, replace the `provider` line and add `baseUrl`:

```ts
      provider: z
        .enum(["anthropic", "claude-cli", "sampling", "auto", "github-models", "ollama", "openai"])
        .default("auto"),
      model: z.string().optional(),
      baseUrl: z.string().url().optional(),
      maxBudgetUsd: z.number().positive().default(10),
```

- [ ] **Step 4: Update the CLI**

In `src/cli.ts`:

Replace the `--provider` USAGE lines (55-56) and the `--model` line context, and add `--base-url`:

```
  --model <id>                model id override
  --provider <anthropic|claude-cli|github-models|ollama|openai|auto>
                             which model backend to use (default: auto)
  --base-url <url>            base URL for --provider openai
                             (or OPENAI_BASE_URL); ignored by other providers
```

Update `PROVIDER_VALUES` (line 76):

```ts
const PROVIDER_VALUES = ["anthropic", "claude-cli", "auto", "github-models", "ollama", "openai"] as const;
```

Add `"base-url"` to the parseArgs options object (alongside `provider`):

```ts
        provider: { type: "string" },
        "base-url": { type: "string" },
```

Read it after `provider` is validated (near line 133-138):

```ts
  const baseUrl = values["base-url"] as string | undefined;
```

Add it to `configInput.model` (near 169-173):

```ts
      model: {
        ...(provider !== undefined ? { provider } : {}),
        ...(values.model !== undefined ? { model: values.model } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
      },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/schemas/mine-config.ts src/cli.ts test/cli.test.ts
git commit -m "feat: CLI + config surface for openai/github-models/ollama providers"
```

---

### Task 4: selectProvider presets + auto fallback

**Files:**
- Modify: `src/model/select-provider.ts` (import provider; add three builders; add switch cases; extend `auto`)
- Test: `test/select-provider.test.ts` (append cases)

**Interfaces:**
- Consumes: `OpenAICompatibleProvider` from Task 1; the extended config type from Task 3 (`config.baseUrl`).
- Produces: `selectProvider` now resolves `"github-models"`, `"ollama"`, `"openai"`, and `"auto"` falls back to `github-models` when `GITHUB_TOKEN`/`GH_TOKEN` is set.

- [ ] **Step 1: Write the failing tests (append to `test/select-provider.test.ts`)**

```ts
import { OpenAICompatibleProvider } from "../src/model/openai-compatible.js";

// ---- presets --------------------------------------------------------------

test('"github-models" with a GitHub token constructs an OpenAICompatibleProvider', () => {
  const p = selectProvider({ ...baseModelConfig, provider: "github-models" }, { GITHUB_TOKEN: "ghtok" }, () => false, noop);
  expect(p).toBeInstanceOf(OpenAICompatibleProvider);
});

test('"github-models" also accepts GH_TOKEN', () => {
  const p = selectProvider({ ...baseModelConfig, provider: "github-models" }, { GH_TOKEN: "ghtok" }, () => false, noop);
  expect(p).toBeInstanceOf(OpenAICompatibleProvider);
});

test('"github-models" with no token throws naming GITHUB_TOKEN', () => {
  const msg = captureThrow(() => selectProvider({ ...baseModelConfig, provider: "github-models" }, {}, () => false, noop));
  expect(msg).toMatch(/GITHUB_TOKEN/);
});

test('"ollama" needs no key and constructs the provider', () => {
  const p = selectProvider({ ...baseModelConfig, provider: "ollama" }, {}, () => false, noop);
  expect(p).toBeInstanceOf(OpenAICompatibleProvider);
});

test('"openai" requires base URL, model, and OPENAI_API_KEY', () => {
  expect(captureThrow(() => selectProvider({ ...baseModelConfig, provider: "openai" }, {}, () => false, noop))).toMatch(/base|OPENAI_BASE_URL/i);
  const withBase = { ...baseModelConfig, provider: "openai" as const, baseUrl: "https://api.example/v1" };
  expect(captureThrow(() => selectProvider(withBase, { OPENAI_API_KEY: "k" }, () => false, noop))).toMatch(/--model/);
  const full = { ...withBase, model: "gpt-x" };
  expect(selectProvider(full, { OPENAI_API_KEY: "k" }, () => false, noop)).toBeInstanceOf(OpenAICompatibleProvider);
});

// ---- auto ordering --------------------------------------------------------

test('"auto" falls back to github-models when only a GitHub token is present', () => {
  const onNotice = vi.fn();
  const p = selectProvider({ ...baseModelConfig, provider: "auto" }, { GITHUB_TOKEN: "ghtok" }, () => false, onNotice);
  expect(p).toBeInstanceOf(OpenAICompatibleProvider);
  expect(onNotice).toHaveBeenCalled();
});

test('"auto" prefers Anthropic over a GitHub token', () => {
  const p = selectProvider({ ...baseModelConfig, provider: "auto" }, { ANTHROPIC_API_KEY: "sk", GITHUB_TOKEN: "gh" }, () => false, noop);
  expect(p).toBeInstanceOf(AnthropicProvider);
});

test('"auto" prefers the claude CLI over a GitHub token', () => {
  const p = selectProvider({ ...baseModelConfig, provider: "auto" }, { GITHUB_TOKEN: "gh" }, () => true, noop);
  expect(p).toBeInstanceOf(ClaudeCliProvider);
});

test('"auto" with nothing available throws mentioning the new providers', () => {
  const msg = captureThrow(() => selectProvider({ ...baseModelConfig, provider: "auto" }, {}, () => false, noop));
  expect(msg).toMatch(/github-models|ollama/);
});

test('"auto" does NOT pick ollama on its own', () => {
  // no anthropic key, no claude CLI, no github token -> error, not an Ollama provider
  expect(() => selectProvider({ ...baseModelConfig, provider: "auto" }, {}, () => false, noop)).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/select-provider.test.ts`
Expected: FAIL — the new provider values aren't handled; `auto` doesn't check GitHub tokens.

- [ ] **Step 3: Implement the builders and wiring**

In `src/model/select-provider.ts`, add the import:

```ts
import { OpenAICompatibleProvider } from "./openai-compatible.js";
```

Inside `selectProvider`, after `buildClaudeCli` is defined, add:

```ts
  const GITHUB_MODELS_BASE = "https://models.github.ai/inference";

  const buildOpenAICompatible = (o: {
    baseUrl: string;
    apiKey?: string;
    model: string;
  }): ModelProvider =>
    new OpenAICompatibleProvider({
      baseUrl: o.baseUrl,
      apiKey: o.apiKey,
      model: o.model,
      maxBudgetUsd: config.maxBudgetUsd,
      onWarn: onNotice,
      // pricePerMTok intentionally omitted: these endpoints are free-tier or
      // arbitrary, so cost tracking is disabled and --max-budget won't gate them.
    });

  const buildGithubModels = (): ModelProvider => {
    const key = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (!key) {
      throw new Error(
        'model.provider "github-models" requires GITHUB_TOKEN or GH_TOKEN to be set (present automatically in GitHub Actions / Codespaces / Copilot environments)',
      );
    }
    return buildOpenAICompatible({ baseUrl: GITHUB_MODELS_BASE, apiKey: key, model: config.model ?? "openai/gpt-4o-mini" });
  };

  const buildOllama = (): ModelProvider =>
    buildOpenAICompatible({
      baseUrl: env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
      model: config.model ?? "qwen2.5:7b",
    });

  const buildOpenAI = (): ModelProvider => {
    const baseUrl = config.baseUrl ?? env.OPENAI_BASE_URL;
    if (!baseUrl) throw new Error('model.provider "openai" requires --base-url or OPENAI_BASE_URL to be set');
    if (!config.model) throw new Error('model.provider "openai" requires --model to be set');
    const key = env.OPENAI_API_KEY;
    if (!key) throw new Error('model.provider "openai" requires OPENAI_API_KEY to be set');
    return buildOpenAICompatible({ baseUrl, apiKey: key, model: config.model });
  };
```

Add switch cases (before `case "sampling":`):

```ts
    case "github-models":
      return buildGithubModels();

    case "ollama":
      return buildOllama();

    case "openai":
      return buildOpenAI();
```

In the `case "auto":` block, insert the GitHub-token fallback after the claude-CLI branch and before the final `throw`:

```ts
      if (env.GITHUB_TOKEN || env.GH_TOKEN) {
        onNotice("no ANTHROPIC_API_KEY and no claude CLI — using GitHub Models (free-tier rate limits apply; use --provider ollama for a full mine)");
        return buildGithubModels();
      }
```

Replace the final `auto` throw message with:

```ts
      throw new Error(
        "no model provider available: set ANTHROPIC_API_KEY (Anthropic API), install Claude Code (claude CLI), set GITHUB_TOKEN (GitHub Models), or use --provider ollama for a local model",
      );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/select-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/model/select-provider.ts test/select-provider.test.ts
git commit -m "feat: github-models/ollama/openai presets + auto GitHub Models fallback"
```

---

### Task 5: Docs + ADR

**Files:**
- Modify: `README.md` (provider section + a "Running inside GitHub Copilot / Codespaces" note)
- Create: `decisions/009-openai-compatible-provider.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add the ADR**

```markdown
<!-- decisions/009-openai-compatible-provider.md -->
# 009. OpenAI-compatible model provider + presets

- Status: accepted
- Date: 2026-07-07
- Refines: 006 (BYO-key model provider)

## Context

prlore only supported Anthropic (`ANTHROPIC_API_KEY`) and the local `claude` CLI.
When a user runs `npx prlore mine` inside a GitHub Copilot / Codespaces / Actions
environment, neither credential exists, so `selectProvider` throws and prlore is
unusable there. The credential that *is* present in those environments is a GitHub
token, which grants access to GitHub Models — an OpenAI-compatible inference endpoint.

## Decision

Add a single generic `OpenAICompatibleProvider` (reusing the existing prompt-based
schema-hint + JSON-extract + 2-attempt retry path) and expose it through three presets:

- `github-models` — `https://models.github.ai/inference`, auth from `GITHUB_TOKEN`/`GH_TOKEN`, default model `openai/gpt-4o-mini`.
- `ollama` — `http://localhost:11434/v1` (or `OLLAMA_BASE_URL`), no key, default model `qwen2.5:7b`.
- `openai` — generic: `--base-url`/`OPENAI_BASE_URL` + `OPENAI_API_KEY` + `--model`.

`auto` falls back to `github-models` when a GitHub token is present, ranked below both
Claude paths. Cost tracking is disabled for these providers (they book $0; `--max-budget`
does not gate them). On HTTP 429 the provider retries with `Retry-After` backoff and, on
quota exhaustion, throws an actionable error steering to Ollama or an Anthropic key.

## Consequences

- prlore runs in Copilot/Codespaces with zero flags.
- The GitHub Models free tier (~50-150 requests/day) realistically only completes a
  small mine; Ollama or a paid/Anthropic path is required for a full mine. This is
  documented, not hidden.
- Structured output stays prompt-based (no `response_format`), so one code path covers
  every endpoint; native structured output is a possible later optimization.
```

- [ ] **Step 2: Update the README provider section**

Add a provider table (or rows, matching the README's existing style) covering
`auto`, `anthropic`, `claude-cli`, `github-models`, `ollama`, `openai`, and a short
subsection:

```markdown
### Running inside GitHub Copilot / Codespaces

prlore auto-detects the environment's `GITHUB_TOKEN` and uses GitHub Models, so
`npx prlore mine <owner/repo>` works with no extra setup. Note the free-tier rate
limits (roughly 50-150 model calls per day depending on model), which realistically
only cover a small mine — scope it down with `--days` or a small window. For a full
mine, run a local model with `--provider ollama` (no rate limits) or set
`ANTHROPIC_API_KEY`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md decisions/009-openai-compatible-provider.md
git commit -m "docs: OpenAI-compatible providers + Copilot/Codespaces usage + ADR 009"
```

---

### Final verification

- [ ] **Full suite:** `npm test` — all green.
- [ ] **Typecheck:** `npx tsc --noEmit` — no errors.
- [ ] **Lint (if configured):** run the repo's configured linter — clean.
- [ ] **Smoke the auto path** (optional, no network): a unit-level assertion already
  covers `auto` → github-models; a live smoke against GitHub Models would need a real
  token and would consume daily quota, so it is intentionally left to manual verification.
