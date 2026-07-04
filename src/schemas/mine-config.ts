import { z } from "zod";

export const MineConfigSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name"),
  baseUrl: z.string().url().default("https://api.github.com"),
  intent: z.string().min(1),
  focusAreas: z.array(z.string()).default([]),
  // Filters kept PRs down to these author logins, case-insensitive. Empty (the
  // default) applies no author filter — every PR that survives the existing
  // keep/drop rules (bot/LGTM stripping) is kept, matching pre-existing behavior.
  authors: z.array(z.string().min(1)).default([]),
  timeRange: z
    .object({
      since: z.string().datetime({ offset: true }).optional(),
      maxPrs: z.number().int().positive().default(1500),
    })
    .prefault({}),
  output: z
    .object({
      target: z.string().default("AGENTS.md"),
      layout: z.enum(["single", "per-area", "auto"]).default("auto"),
      citations: z.enum(["inline-light", "sidecar-only"]).default("inline-light"),
      // v0.3 Task 4: the top maxRules (by score, which is already the sort order
      // rules arrive in) render fully in their planned sections; anything beyond
      // the cap renders as a compact one-liner in a single trailing section
      // instead of being silently dropped. Positive-int only — "no cap" means
      // passing a large value, not 0 (see src/cli.ts's --max-rules validation).
      maxRules: z.number().int().positive().default(60),
    })
    .prefault({}),
  model: z
    .object({
      // "auto" (the default) resolves to "anthropic" whenever ANTHROPIC_API_KEY is
      // set — which is every config that used to omit `provider` and get the old
      // "anthropic" default, since AnthropicProvider was never reachable without a
      // key anyway. So the observed behavior of every pre-existing config is
      // unchanged by this default flip; see selectProvider() in
      // src/model/select-provider.ts for the resolution logic and the "sampling"
      // hard-error, which still lives at the mine tool layer (src/server-tools.ts).
      provider: z.enum(["anthropic", "claude-cli", "sampling", "auto"]).default("auto"),
      model: z.string().optional(),
      maxBudgetUsd: z.number().positive().default(10),
    })
    .prefault({}),
});

export type MineConfig = z.infer<typeof MineConfigSchema>;
