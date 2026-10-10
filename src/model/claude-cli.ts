import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractJson } from "./anthropic.js";
import { BudgetExceededError, type CompleteOptions, type ModelProvider } from "./provider.js";
import { appendSchemaHint } from "./schema-hint.js";

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

/**
 * prlore only needs a JSON completion, and the prompt carries untrusted text
 * (third-party PR review comments, files from the mined repo). These flags
 * keep the headless session inert: no built-in tools, no MCP servers, and no
 * project or local settings (hooks, permissions) from whatever directory the
 * CLI would otherwise treat as the project. The child also runs in a fresh
 * empty temp dir (see defaultRunCli) so the mined clone is never its project.
 */
export const CLAUDE_CLI_ISOLATION_ARGS: readonly string[] = [
  "--tools",
  "",
  "--strict-mcp-config",
  "--setting-sources",
  "user",
];

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

      const baseInput =
        attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous reply was invalid: ${lastError}\nReply with ONLY valid JSON matching the requested shape.`;
      const input = appendSchemaHint(baseInput, schema);

      const args = ["-p", "--output-format", "json", ...CLAUDE_CLI_ISOLATION_ARGS];
      if (this.opts.model) args.push("--model", this.opts.model);
      if (system) args.push("--system-prompt", system);

      const { stdout, exitCode, stderr } = await this.invoke(args, input);

      if (exitCode !== 0) {
        const excerpt = stderr.slice(0, STDERR_EXCERPT_LEN);
        throw new Error(`claude CLI exited with code ${exitCode}: ${excerpt}`);
      }

      let envelope: ClaudeCliEnvelope;
      try {
        envelope = JSON.parse(stdout) as ClaudeCliEnvelope;
      } catch {
        const excerpt = stdout.slice(0, STDERR_EXCERPT_LEN);
        throw new Error(`claude CLI returned non-JSON output: ${excerpt}`);
      }
      const rawCost = envelope.total_cost_usd;
      const validCost = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0;
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

async function defaultRunCli(
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  // Never inherit process.cwd(): for `prlore mine` that is usually the clone
  // being mined, whose .claude/ settings and CLAUDE.md must not be loaded.
  const cwd = await mkdtemp(join(tmpdir(), "prlore-claude-"));
  try {
    return await spawnClaude(args, input, timeoutMs, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function spawnClaude(
  args: string[],
  input: string,
  timeoutMs: number,
  cwd: string,
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
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

    // If the CLI exits before reading the whole prompt (auth failure, bad
    // flag), the write fails with EPIPE. Without a listener that error is
    // uncaught and kills the process; swallow it here so the close handler
    // reports the exit code and stderr instead.
    child.stdin.on("error", () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}
