import Anthropic from "@anthropic-ai/sdk";
import { BudgetExceededError, type CompleteOptions, type ModelProvider } from "./provider.js";

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

  constructor(
    private readonly opts: { model?: string; maxBudgetUsd: number },
    private readonly client: MessagesClient = new Anthropic() as unknown as MessagesClient,
  ) {}

  spentUsd(): number {
    return this.spent;
  }

  async complete<T>({ system, prompt, schema, maxTokens = 4096 }: CompleteOptions<T>): Promise<T> {
    const model = this.opts.model ?? DEFAULT_MODEL;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.spent >= this.opts.maxBudgetUsd) {
        throw new BudgetExceededError(this.spent, this.opts.maxBudgetUsd);
      }
      const content =
        attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous reply was invalid: ${lastError}\nReply with ONLY valid JSON matching the requested shape.`;
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
    const price = PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
    this.spent += (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000;
  }
}

function extractJson(text: string): string {
  const start = text.search(/[[{]/);
  if (start === -1) return text;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  return end > start ? text.slice(start, end + 1) : text;
}
