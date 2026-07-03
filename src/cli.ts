import { parseArgs } from "node:util";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { z, ZodError } from "zod";
import { emitDraft, EmitRefusedError, type EmitTarget } from "./emitter/emit.js";
import { finalizeDraft } from "./emitter/finalize.js";
import { JobManager, type JobDeps, type JobManagerApi } from "./jobs/manager.js";
import type { JobStatus } from "./jobs/registry.js";
import { MineConfigSchema, type MineConfig } from "./schemas/mine-config.js";

// Plan Task 3 contract (verbatim shape): every dependency the CLI touches is
// injected, so runMineCli is fully testable without a real terminal, GitHub
// token, model provider, or filesystem write. src/index.ts wires the real ones.
//
// `pollIntervalMs` is NOT part of the plan's literal CliDeps shape — it's this
// implementation's answer to the plan's open question ("keep the poll loop
// testable... your call, disclose"). Defaulting to 5000 (the spec's 5s interval)
// and letting tests override it to 0 collapses the inter-poll delay to nothing
// while still exercising the exact same poll-until-terminal loop a real 5-minute
// mining run drives, against a manager that returns a scripted status sequence.
export interface CliDeps {
  makeDeps: (config: MineConfig, ctx: { repoPath: string; stateDir: string }) => Promise<JobDeps>;
  manager?: JobManagerApi;
  stdout: Writable;
  stderr: Writable;
  confirm: (question: string) => Promise<boolean>;
  now?: () => number;
  pollIntervalMs?: number;
}

const DEFAULT_INTENT = "onboard an AI coding agent to contribute changes matching this repo's conventions";

export const USAGE = `usage: prlore mine <owner/repo> [options]

  --intent <text>           what the resulting doc should help with
                             (default: "${DEFAULT_INTENT}")
  --since <ISO-datetime>     only PRs updated at/after this timestamp
  --days <n>                 only PRs updated in the last <n> days
                             (--since and --days are mutually exclusive)
  --budget <usd>             max USD to spend on model calls (default: 10)
  --model <id>                model id override
  --provider <anthropic|claude-cli|auto>
                             which model backend to use (default: auto)
  --repo-path <path>         local checkout to mine against (default: cwd)
  --target <file>            output file (default: AGENTS.md)
  --yes                       skip the write confirmation prompt
  --dry-run                   preview only; never writes, even with --yes
`;

class CliUsageError extends Error {}

interface ParsedMineArgs {
  repoPath: string;
  yes: boolean;
  dryRun: boolean;
  configInput: Record<string, unknown>;
}

const PROVIDER_VALUES = ["anthropic", "claude-cli", "auto"] as const;

function parseMineArgs(argv: string[], now: () => number): ParsedMineArgs {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        intent: { type: "string" },
        since: { type: "string" },
        days: { type: "string" },
        budget: { type: "string" },
        model: { type: "string" },
        provider: { type: "string" },
        "repo-path": { type: "string" },
        target: { type: "string" },
        yes: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length !== 1) {
    throw new CliUsageError(
      `expected exactly one positional argument <owner/repo>, got ${positionals.length}`,
    );
  }
  const repo = positionals[0]!;

  if (values.since !== undefined && values.days !== undefined) {
    throw new CliUsageError("--since and --days are mutually exclusive");
  }

  let since: string | undefined = values.since as string | undefined;
  if (values.days !== undefined) {
    const days = Number(values.days);
    if (!Number.isFinite(days) || days <= 0) {
      throw new CliUsageError(`--days must be a positive number, got "${values.days as string}"`);
    }
    since = new Date(now() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  let maxBudgetUsd: number | undefined;
  if (values.budget !== undefined) {
    maxBudgetUsd = Number(values.budget);
    if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
      throw new CliUsageError(`--budget must be a positive number, got "${values.budget as string}"`);
    }
  }

  const provider = values.provider as string | undefined;
  if (provider !== undefined && !(PROVIDER_VALUES as readonly string[]).includes(provider)) {
    throw new CliUsageError(
      `--provider must be one of ${PROVIDER_VALUES.join(", ")} — got "${provider}"`,
    );
  }

  const repoPath = (values["repo-path"] as string | undefined) ?? process.cwd();
  const target = (values.target as string | undefined) ?? "AGENTS.md";

  return {
    repoPath,
    yes: (values.yes as boolean | undefined) ?? false,
    dryRun: (values["dry-run"] as boolean | undefined) ?? false,
    configInput: {
      repo,
      intent: (values.intent as string | undefined) ?? DEFAULT_INTENT,
      ...(since !== undefined ? { timeRange: { since } } : {}),
      output: { target },
      model: {
        ...(provider !== undefined ? { provider } : {}),
        ...(values.model !== undefined ? { model: values.model } : {}),
        ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
      },
    },
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminal(state: JobStatus["state"]): boolean {
  return state === "ready-for-preview" || state === "failed" || state === "cancelled";
}

function formatProgress(status: JobStatus): string {
  const parts = [`stage=${status.stage ?? status.state}`];
  if (status.counters) {
    for (const [k, v] of Object.entries(status.counters)) parts.push(`${k}=${v}`);
  }
  parts.push(`spent=$${(status.tokensSpentUsd ?? 0).toFixed(2)}`);
  return `prlore: ${parts.join(" ")}`;
}

/**
 * Runs `prlore mine` end to end in-process: parse args -> validate config ->
 * build deps -> start the job -> poll status to a terminal state -> print the
 * preview -> gate the write on confirm (or --yes) -> write via the exact same
 * finalizeDraft the MCP `write` tool uses. Returns the process exit code;
 * never calls process.exit itself so callers (and tests) stay in control.
 */
export async function runMineCli(argv: string[], deps: CliDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 5000;

  let parsed: ParsedMineArgs;
  try {
    parsed = parseMineArgs(argv, now);
  } catch (err) {
    deps.stderr.write(`prlore: ${errMessage(err)}\n\n${USAGE}`);
    return 2;
  }

  let config: MineConfig;
  try {
    config = MineConfigSchema.parse(parsed.configInput);
  } catch (err) {
    if (err instanceof ZodError) {
      deps.stderr.write(`prlore: invalid configuration\n${z.prettifyError(err)}\n`);
      return 2;
    }
    throw err;
  }

  const repoPath = parsed.repoPath;
  const stateDir = join(repoPath, ".prlore");

  let jobDeps: JobDeps;
  try {
    jobDeps = await deps.makeDeps(config, { repoPath, stateDir });
  } catch (err) {
    // Provider/transport construction failures (missing ANTHROPIC_API_KEY, no
    // claude CLI on PATH, unresolvable GitHub token) are configuration problems
    // discoverable before any pipeline work runs — treated as usage/config
    // errors (exit 2), not a mid-run job failure (exit 1).
    deps.stderr.write(`prlore: ${errMessage(err)}\n`);
    return 2;
  }

  const manager = deps.manager ?? new JobManager();

  let jobId: string;
  try {
    ({ jobId } = manager.start(config, jobDeps));
  } catch (err) {
    deps.stderr.write(`prlore: ${errMessage(err)}\n`);
    return 1;
  }

  let status = manager.status(jobId);
  while (!isTerminal(status.state)) {
    deps.stderr.write(`${formatProgress(status)}\n`);
    await sleep(pollIntervalMs);
    status = manager.status(jobId);
  }

  if (status.state === "failed") {
    deps.stderr.write(`prlore: job failed: ${status.error ?? "unknown error"}\n`);
    return 1;
  }
  if (status.state === "cancelled") {
    deps.stderr.write("prlore: job was cancelled before completion\n");
    return 1;
  }

  const result = manager.result(jobId);
  if (!result) {
    deps.stderr.write("prlore: job reported ready-for-preview but produced no result\n");
    return 1;
  }

  deps.stdout.write(result.draft.endsWith("\n") ? result.draft : `${result.draft}\n`);

  // Contested items: v1 has no --resolve-contested equivalent (spec is binding —
  // no resolveContested in CLI v1). They are always left out of the written
  // file; the remediation path is the MCP write tool's resolveContested, or a
  // manual edit after the fact.
  for (const item of result.contested) {
    deps.stderr.write(
      `contested: ${item.statement} — ${item.reason} (left out of the written file; resolve via the MCP write tool or edit manually)\n`,
    );
  }

  deps.stderr.write(
    `prlore: ${result.provenance.rules.length} rules, ${result.provenance.dropped.length} dropped, ` +
      `${result.contested.length} contested, spent $${(status.tokensSpentUsd ?? 0).toFixed(2)}\n`,
  );

  if (parsed.dryRun) {
    deps.stdout.write("dry run: not written\n");
    return 0;
  }

  const shouldWrite = parsed.yes ? true : await deps.confirm(`Write ${config.output.target}?`);
  if (!shouldWrite) {
    deps.stdout.write("not written\n");
    return 0;
  }

  // The never-write-without-preview property holds structurally: every path that
  // reaches here already printed the preview above (draft to stdout, contested to
  // stderr) — there is no branch that calls emitDraft without having done so first.
  const finalDraft = finalizeDraft(result.draft, []); // v1: contested items are never "kept" from the CLI
  const target: EmitTarget = { repoPath, target: config.output.target, layout: config.output.layout };

  try {
    const emitResult = await emitDraft(finalDraft, result.provenance, target);
    deps.stdout.write(`wrote: ${emitResult.pathsWritten.join(", ")}\n`);
    return 0;
  } catch (err) {
    if (err instanceof EmitRefusedError) {
      deps.stderr.write(
        `prlore: ${err.message} — resolve the marker issue in the target file, or point --target at a fresh file, then re-run\n`,
      );
      return 1;
    }
    throw err;
  }
}
