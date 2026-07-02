import { NormalizedPrSchema, type NormalizedPr } from "../schemas/normalized-pr.js";
import { readJsonl } from "./jsonl.js";

export async function readCorpus(
  path: string,
): Promise<{ prs: NormalizedPr[]; drifted: number }> {
  const raw = await readJsonl<unknown>(
    path,
    (r) => r,
    (r) => {
      const n = (r as { number?: unknown } | null)?.number;
      return typeof n === "number" ? n : -1; // invalid lines share a bucket; dropped below
    },
  );
  const prs: NormalizedPr[] = [];
  let drifted = 0;
  for (const item of raw) {
    const parsed = NormalizedPrSchema.safeParse(item);
    if (parsed.success) prs.push(parsed.data);
    else drifted++;
  }
  return { prs, drifted };
}
