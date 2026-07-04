import Anthropic from "@anthropic-ai/sdk";
import { BudgetExceededError, type CompleteOptions, type ModelProvider } from "./provider.js";
import { appendSchemaHint } from "./schema-hint.js";

const DEFAULT_MODEL = "claude-sonnet-5";
// USD per MTok, sticker prices (intro discounts ignored so tracking over-estimates).
// Verified 2026-07-01 against docs.anthropic.com model catalog.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

interface Usage { input_tokens: number; output_tokens: number }
interface MessagesClient {
  messages: {
    create(params: {
      model: string; max_tokens: number; system?: string;
      messages: { role: "user"; content: string }[];
    }): Promise<{ content: { type: string; text?: string }[]; usage: Usage }>;
  };
}

export class AnthropicProvider implements ModelProvider {
  private spent = 0;
  private readonly model: string;

  constructor(
    private readonly opts: { model?: string; maxBudgetUsd: number },
    private readonly client: MessagesClient = new Anthropic() as unknown as MessagesClient,
  ) {
    const model = opts.model ?? DEFAULT_MODEL;
    if (!(model in PRICES)) {
      throw new Error(`no price data for model "${model}"; known models: ${Object.keys(PRICES).join(", ")}`);
    }
    this.model = model;
  }

  spentUsd(): number {
    return this.spent;
  }

  async complete<T>({ system, prompt, schema, maxTokens = 4096 }: CompleteOptions<T>): Promise<T> {
    const model = this.model;
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
      const res = await this.client.messages.create({
        model, max_tokens: maxTokens, system,
        messages: [{ role: "user", content }],
      });
      this.track(model, res.usage);
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      try {
        return schema.parse(JSON.parse(extractJson(text)));
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(`model output failed schema validation twice: ${lastError}`);
  }

  private track(model: string, usage: Usage): void {
    const price = PRICES[model]!;
    this.spent += (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000;
  }
}

export function extractJson(text: string): string {
  const start = text.search(/[[{]/);
  if (start === -1) return text;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text;
}
