import { spawn } from "node:child_process";
import { extractJson } from "./anthropic.js";
import { BudgetExceededError, type CompleteOptions, type ModelProvider } from "./provider.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const STDERR_EXCERPT_LEN = 300;

/**
 * Runs the claude CLI once: `args` are the flags (no positional prompt — the
 * prompt goes over stdin, per the live probe), `input` is the stdin payload,
 * `timeoutMs` bounds the call.
 *
 * NOTE ON THE RETURN SHAPE: the plan's contract text writes this as
 * `Promise<{ stdout: string; exitCode: number }>`, but the binding semantics
 * immediately below it require surfacing "a stderr excerpt" on non-zero exit,
 * and the default implementation is specified to capture "stderr ... for
 * error messages only". Those two requirements are unsatisfiable without a
 * stderr channel on the return value, so this type adds `stderr: string` —
 * an interpretation call to make the two prose requirements consistent,
 * documented per the report instructions.
 */
export type RunCli = (
  args: string[],
  input: string,
  timeoutMs: number,
) => Promise<{ stdout: string; exitCode: number; stderr: string }>;

interface ClaudeCliEnvelope {
  result?: unknown;
  total_cost_usd?: unknown;
}

export class ClaudeCliProvider implements ModelProvider {
  private spent = 0;
  private readonly runCli: RunCli;

  constructor(
    private readonly opts: { model?: string; maxBudgetUsd: number; onWarn?: (msg: string) => void },
    runCli: RunCli = defaultRunCli,
  ) {
    this.runCli = runCli;
  }

  spentUsd(): number {
    return this.spent;
  }

  async complete<T>({ system, prompt, schema }: CompleteOptions<T>): Promise<T> {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.spent >= this.opts.maxBudgetUsd) {
        throw new BudgetExceededError(this.spent, this.opts.maxBudgetUsd);
      }

      const input =
        attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous reply was invalid: ${lastError}\nReply with ONLY valid JSON matching the requested shape.`;

      const args = ["-p", "--output-format", "json"];
      if (this.opts.model) args.push("--model", this.opts.model);
      if (system) args.push("--system-prompt", system);

      const { stdout, exitCode, stderr } = await this.invoke(args, input);

      if (exitCode !== 0) {
        const excerpt = stderr.slice(0, STDERR_EXCERPT_LEN);
        throw new Error(`claude CLI exited with code ${exitCode}: ${excerpt}`);
      }

      const envelope = JSON.parse(stdout) as ClaudeCliEnvelope;
      const rawCost = envelope.total_cost_usd;
      const validCost = typeof rawCost === "number" && Number.isFinite(rawCost);
      if (!validCost) {
        this.opts.onWarn?.("claude CLI response missing or invalid total_cost_usd; booked $0");
      }
      this.spent += validCost ? rawCost : 0;

      const resultText = typeof envelope.result === "string" ? envelope.result : "";
      try {
        return schema.parse(JSON.parse(extractJson(resultText)));
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(`model output failed schema validation twice: ${lastError}`);
  }

  private async invoke(args: string[], input: string) {
    try {
      return await this.runCli(args, input, DEFAULT_TIMEOUT_MS);
    } catch (err) {
      if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("claude CLI not found on PATH — install Claude Code or set ANTHROPIC_API_KEY");
      }
      throw err;
    }
  }
}

function defaultRunCli(
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, exitCode: code ?? -1, stderr });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}
