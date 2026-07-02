import { z } from "zod";
import type { ModelProvider } from "../model/provider.js";
import type { NormalizedPr } from "../schemas/normalized-pr.js";
import { AssociationSchema } from "../schemas/normalized-pr.js";
import type { CandidateLearning } from "../schemas/candidate-learning.js";

export const EXTRACTOR_PROMPT_VERSION = "1";

const DraftSchema = z.object({
  learnings: z.array(
    z.object({
      statement: z.string().min(1),
      rationale: z.string().optional(),
      category: z.enum(["style", "architecture", "testing", "process", "tooling", "domain"]),
      scope: z.array(z.string()).optional(),
      polarity: z.enum(["prescriptive", "proscriptive"]),
      quotes: z
        .array(
          z.object({
            author: z.string(),
            association: AssociationSchema,
            quote: z.string().min(1),
            createdAt: z.string(),
          }),
        )
        .min(1),
    }),
  ),
});

const SYSTEM = `You extract durable engineering conventions from a pull request's review discussion.
A learning is a rule, preference, or rationale that generalizes beyond this one diff:
"we always X", "don't use Y here because Z", a maintainer correction the author applied,
a stated convention. NOT learnings: one-off nitpicks, questions, praise, CI chatter,
anything specific to this diff only. Quote the exact sentence(s) that state each learning.
If the discussion contains none, return {"learnings": []}. Respond with ONLY JSON.`;

const BODY_CAP = 2_000;
const DISCUSSION_CAP = 12_000;
const TRUNCATION_MARKER = "\n[...truncated]";

export function renderPrDiscussion(pr: NormalizedPr): string {
  const parts: string[] = [];
  for (const t of pr.threads) {
    const where = t.path ? ` on ${t.path}${t.line ? `:${t.line}` : ""}` : "";
    parts.push(`Thread${where}${t.resolved ? " (resolved)" : ""}:`);
    for (const c of t.comments) {
      parts.push(`  ${c.author} (${c.association}) at ${c.createdAt}: ${c.body}`);
    }
  }
  for (const r of pr.reviews) {
    if (r.body.trim()) parts.push(`Review by ${r.author} (${r.association}, ${r.state}): ${r.body}`);
  }
  for (const c of pr.comments) {
    parts.push(`Comment by ${c.author} (${c.association}) at ${c.createdAt}: ${c.body}`);
  }
  const full = parts.join("\n");
  if (full.length <= DISCUSSION_CAP) return full;
  return full.slice(0, DISCUSSION_CAP) + TRUNCATION_MARKER;
}

function defaultScope(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const idx = f.lastIndexOf("/");
    if (idx > 0) dirs.add(`${f.slice(0, idx)}/**`);
    if (dirs.size >= 5) break;
  }
  return [...dirs];
}

export async function extractOne(
  pr: NormalizedPr,
  provider: ModelProvider,
  model?: string,
): Promise<CandidateLearning[]> {
  const prompt = `## PR #${pr.number}: ${pr.title}
Author: ${pr.author} (${pr.authorAssociation}) | State: ${pr.state} | Files: ${pr.files.slice(0, 30).join(", ")}

## Description
${pr.body.slice(0, BODY_CAP)}

## Discussion
${renderPrDiscussion(pr)}

Extract the durable learnings per the rules. JSON only.`;

  const draft = await provider.complete({
    system: SYSTEM,
    prompt,
    schema: DraftSchema,
    maxTokens: 4096,
  });

  return draft.learnings.map((l) => ({
    statement: l.statement,
    ...(l.rationale ? { rationale: l.rationale } : {}),
    category: l.category,
    scope: l.scope ?? defaultScope(pr.files),
    polarity: l.polarity,
    evidence: l.quotes.map((q) => ({ pr: pr.number, ...q })),
  }));
}
