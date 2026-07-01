import { z } from "zod";

export const MineConfigSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name"),
  baseUrl: z.string().url().default("https://api.github.com"),
  intent: z.string().min(1),
  focusAreas: z.array(z.string()).default([]),
  timeRange: z
    .object({
      since: z.string().datetime({ offset: true }).optional(),
      maxPrs: z.number().int().positive().optional(),
    })
    .default({})
    .transform((v) => ({
      ...v,
      maxPrs: v.maxPrs ?? 1500,
    })),
  output: z
    .object({
      target: z.string().optional(),
      layout: z.enum(["single", "per-area", "auto"]).optional(),
      citations: z.enum(["inline-light", "sidecar-only"]).optional(),
    })
    .default({})
    .transform((v) => ({
      ...v,
      target: v.target ?? "AGENTS.md",
      layout: v.layout ?? "auto",
      citations: v.citations ?? "inline-light",
    })),
  model: z
    .object({
      provider: z.enum(["anthropic", "sampling"]).optional(),
      model: z.string().optional(),
      maxBudgetUsd: z.number().positive().optional(),
    })
    .default({})
    .transform((v) => ({
      ...v,
      provider: v.provider ?? "anthropic",
      maxBudgetUsd: v.maxBudgetUsd ?? 10,
    })),
});

export type MineConfig = z.infer<typeof MineConfigSchema>;
