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
