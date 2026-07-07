import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeTransport, resolveToken, withRetry } from "./github/client.js";
import { emitDraft, EmitRefusedError, type EmitTarget } from "./emitter/emit.js";
import { finalizeDraft } from "./emitter/finalize.js";
import { previewEmitMode, writePlanSummary } from "./emitter/mode.js";
import type { JobDeps, JobManagerApi } from "./jobs/manager.js";
import { hasClaudeCli, selectProvider } from "./model/select-provider.js";
import { MineConfigSchema, type MineConfig } from "./schemas/mine-config.js";
import type { ContestedItem, Provenance } from "./schemas/provenance.js";

// Phase 6 Task 5 seam: `mine`'s real wiring (resolveToken -> withRetry(makeTransport) +
// a real AnthropicProvider) reaches out to GitHub and Anthropic — no way to inject a
// fake transport/provider around it from a test without this factory indirection. This
// is the ONLY change Task 5 needed in src/ to drive the full MCP tool surface
// (mine -> status -> preview -> write) against a real JobManager with just network+LLM
// faked, instead of forking the pipeline logic into the test. Defaults to the exact
// wiring `mine` used inline before this change; production callers (src/index.ts via
// buildServer()) are unaffected.
export type MineDepsFactory = (
  config: MineConfig,
  ctx: { repoPath: string; stateDir: string },
) => JobDeps | Promise<JobDeps>;

export const defaultMineDepsFactory: MineDepsFactory = async (config, { repoPath, stateDir }) => {
  const token = await resolveToken();
  const transport = withRetry(makeTransport(token, config.baseUrl));
  // onNotice routing: JobDeps (jobs/manager.ts) carries no notice/warning channel —
  // JobStatus.warnings lives on the RunningJob that JobManager.start() constructs,
  // and that happens strictly AFTER this factory returns (deps are built, then
  // passed into manager.start()). There is no live status object to append to at
  // this point, so there's nothing to route into. Falling back to stderr keeps the
  // notice visible via the same out-of-band channel the CLI/MCP host already treats
  // as diagnostic output (see Global Constraints: "progress → stderr").
  const provider = selectProvider(config.model, process.env, hasClaudeCli, (msg) => {
    process.stderr.write(`prlore: ${msg}\n`);
  });
  return { transport, provider, stateDir, repoPath };
};

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

// The confirm-token gate (spec §8) and the target/layout the last `mine` call
// requested live here, at the tool layer — not on JobManagerApi. A JobManager (real
// or stub) only knows how to run the pipeline; preview/write's never-write-
// without-preview guarantee is an MCP-session concern layered on top of it. Single
// job per manager instance (spec §9.8) means one outstanding preview at a time is
// the correct granularity: a fresh `mine` call or a fresh `preview` call always
// invalidates whatever came before.
interface PreviewState {
  token: string;
  jobId: string;
  draft: string;
  provenance: Provenance;
  contested: ContestedItem[];
}

export function registerTools(
  server: McpServer,
  manager: JobManagerApi,
  depsFactory: MineDepsFactory = defaultMineDepsFactory,
): void {
  let lastMineTarget: EmitTarget | null = null;
  let previewState: PreviewState | null = null;

  server.registerTool(
    "mine",
    {
      description:
        "Start mining a repo's PR-review history and current code into a conventions draft. Rejects while a job is already running.",
      inputSchema: {
        ...MineConfigSchema.shape,
        repoPath: z.string().optional(),
        stateDir: z.string().optional(),
      },
    },
    async ({ repoPath: repoPathIn, stateDir: stateDirIn, ...configFields }) => {
      try {
        const repoPath = repoPathIn ?? process.cwd();
        const stateDir = stateDirIn ?? join(repoPath, ".prlore");
        const config = MineConfigSchema.parse(configFields);
        // MineConfigSchema accepts "sampling" (MCP sampling as a fallback when no
        // API key is configured) but v1 never wired that path — defaultMineDepsFactory
        // always constructs a real AnthropicProvider regardless of this field. Silently
        // running Anthropic under a config that asked for sampling would be a lie the
        // caller has no way to detect; fail closed with a clear tool error instead.
        if (config.model.provider === "sampling") {
          throw new Error('model.provider "sampling" is not implemented in v1; use "anthropic"');
        }
        const deps = await depsFactory(config, { repoPath, stateDir });

        const { jobId, resumed } = manager.start(config, deps);
        lastMineTarget = { repoPath, target: config.output.target, layout: config.output.layout };
        previewState = null; // a fresh job invalidates any preview issued for a prior one
        return jsonContent({ jobId, resumed });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "status",
    {
      description:
        "Report the state of the current prlore mining job: stage, progress counters, rate-limit budget.",
      inputSchema: { jobId: z.string().optional() },
    },
    async ({ jobId }) => {
      try {
        return jsonContent(manager.status(jobId));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "cancel",
    {
      description: "Cancel the current mining job. It checkpoints at the next stage boundary.",
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      try {
        return jsonContent(await manager.cancel(jobId));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "preview",
    {
      description:
        "Preview the draft a completed mining job produced. Requires the job to be ready-for-preview. Issues a confirmToken that `write` must echo back — the only way to actually write files.",
      inputSchema: { jobId: z.string().optional() },
    },
    async ({ jobId }) => {
      try {
        const status = manager.status(jobId);
        if (status.state !== "ready-for-preview" || !status.jobId) {
          throw new Error(`no job ready for preview (state: ${status.state})`);
        }
        const result = manager.result(status.jobId);
        if (!result) {
          throw new Error(`no job ready for preview (state: ${status.state})`);
        }
        if (!lastMineTarget) {
          throw new Error("no mine target on record — call mine before preview");
        }

        const token = randomUUID();
        previewState = {
          token,
          jobId: status.jobId,
          draft: result.draft,
          provenance: result.provenance,
          contested: result.contested,
        };

        // Read-only preview of which mode `write` will run (direct vs pointer)
        // and whether it would refuse. An unmarked human `<target>` now ADOPTS
        // pointer mode (full doc → .prlore/<target>, a pointer block appended to
        // the human file) rather than refusing; only corrupt/lone markers, or an
        // unmarked/corrupt `.prlore/<target>`, still refuse. writePlan tells the
        // caller in one line what will actually happen.
        const modePreview = await previewEmitMode(lastMineTarget.repoPath, lastMineTarget.target);
        const writePlan = modePreview.wouldRefuse
          ? `would refuse to write ${lastMineTarget.target}: ${modePreview.reason ?? "corrupt managed-block markers"}`
          : writePlanSummary(modePreview.mode, lastMineTarget.target);

        return jsonContent({
          markdown: result.draft,
          contested: result.contested,
          stats: {
            rulesIncluded: result.provenance.rules.length,
            droppedCount: result.provenance.dropped.length,
            contestedCount: result.contested.length,
          },
          confirmToken: token,
          targetExists: modePreview.targetExists,
          wouldRefuse: modePreview.wouldRefuse,
          mode: modePreview.mode,
          writePlan,
          ...(modePreview.reason ? { refusalReason: modePreview.reason } : {}),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "write",
    {
      description:
        "Write the previewed draft to disk. Requires the confirmToken from the most recent `preview` call — write never touches disk without one.",
      inputSchema: {
        confirmToken: z.string(),
        resolveContested: z.array(z.object({ id: z.string(), action: z.enum(["keep", "drop"]) })).optional(),
      },
    },
    async ({ confirmToken, resolveContested }) => {
      try {
        if (!previewState || confirmToken !== previewState.token) {
          throw new Error("invalid or stale confirm token — call preview again");
        }
        if (!lastMineTarget) {
          throw new Error("no mine target on record — call mine before write");
        }

        // Clear-before-await, not clear-after: the token check above and this
        // clear must be one synchronous unit with no `await` between them, or two
        // concurrent write calls sharing the same token can both pass the check
        // before either clears it (TOCTOU). Capture everything this handler still
        // needs from previewState into locals first, since previewState itself is
        // about to go null. A write that fails downstream (emitDraft throwing)
        // does NOT get the token back — a failed write already consumed it, and
        // the caller re-previews for a fresh one, same as any other stale-token
        // path.
        const { draft, provenance, contested } = previewState;
        const target = lastMineTarget;
        previewState = null; // single-use: consumed synchronously, before any await

        // A resolved id applies everywhere it appears among this job's contested
        // items (conflict chains can surface the same rule id in more than one
        // item) — filtering the full contested list against the keep-id set
        // already covers every occurrence, not just the first.
        const keepIds = new Set((resolveContested ?? []).filter((r) => r.action === "keep").map((r) => r.id));
        const resolvedStatements = contested
          .filter((item) => keepIds.has(item.id))
          .map((item) => item.statement);

        const finalDraft = finalizeDraft(draft, resolvedStatements);

        let result;
        try {
          result = await emitDraft(finalDraft, provenance, target);
        } catch (err) {
          if (err instanceof EmitRefusedError) throw new Error(err.message);
          throw err;
        }

        return jsonContent({ pathsWritten: result.pathsWritten });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  const INTERVIEW_SCRIPT = [
    "You are conducting a short intake interview to configure a prlore mining run.",
    "Gather the following from the user conversationally, one topic at a time — do not dump this whole checklist on them at once:",
    "",
    "1. Repo: which GitHub repo to mine, as `owner/name`.",
    "2. Intent: in their own words, why they want this (free text) — what should the resulting conventions doc help with?",
    "3. Focus areas (optional): specific directories, subsystems, or topics to prioritize. Empty is fine — it means \"everything\".",
    "4. Output preferences (optional): target file path (default AGENTS.md), layout (single file vs. per-area vs. auto), and whether citations should be inline or sidecar-only.",
    "5. Budget/model preferences (optional): a max USD budget for the run and which model to use, if they care to set either.",
    "",
    "Once you have at least the repo and the intent, call the `mine` tool with everything gathered. Do not fabricate answers for fields the user didn't give you — omit them and let prlore's defaults apply.",
  ].join("\n");

  server.registerPrompt(
    "interview",
    {
      title: "prlore intake interview",
      description: "Conversational script for gathering mine() inputs from the user before starting a run.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: INTERVIEW_SCRIPT },
        },
      ],
    }),
  );
}
