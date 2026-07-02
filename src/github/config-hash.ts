import { createHash } from "node:crypto";
import type { MineConfig } from "../schemas/mine-config.js";

export function configHash(config: MineConfig): string {
  const identity = {
    repo: config.repo,
    baseUrl: config.baseUrl,
    since: config.timeRange.since ?? null,
    maxPrs: config.timeRange.maxPrs,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
