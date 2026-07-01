import { z } from "zod";

export const MineConfigSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name"),
  baseUrl: z.string().url().default("https://api.github.com"),
  intent: z.string().min(1),
  focusAreas: z.array(z.string()).default([]),
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
    })
    .prefault({}),
  model: z
    .object({
      provider: z.enum(["anthropic", "sampling"]).default("anthropic"),
      model: z.string().optional(),
      maxBudgetUsd: z.number().positive().default(10),
    })
    .prefault({}),
});

export type MineConfig = z.infer<typeof MineConfigSchema>;
