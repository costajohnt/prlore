import { z } from "zod";
import type { ModelProvider } from "../model/provider.js";
import type { PatternsModel } from "../schemas/patterns-model.js";
import type { RuleRecord } from "../schemas/provenance.js";

export const DocPlanSchema = z.object({
  title: z.string().min(1),
  overview: z.string(),
  sections: z.array(z.object({ heading: z.string().min(1), ruleIds: z.array(z.string()) })),
  perArea: z.boolean(),
});
export type DocPlan = z.infer<typeof DocPlanSchema>;
type DocPlanSection = DocPlan["sections"][number];

const SYSTEM = `You plan the structure of a generated engineering-conventions document. You are
given the intent the document must serve, the repo's areas, and a list of corroborated rules.
Choose a title and an overview paragraph whose voice fits the intent. Group the rules into 3-7
sections ordered by usefulness to the intent, listing each section's ruleIds in the order they
should appear. Set perArea to true only if the areas' stacks or concerns genuinely diverge enough
to warrant per-area sections; otherwise false. Respond with ONLY JSON matching the schema.`;

const OTHER_CONVENTIONS_HEADING = "Other conventions";
const RESCUE_THRESHOLD = 0.5;
const LINE_BUDGET = 400;
const HEADER_LINES = 6;
const SECTION_OVERHEAD_LINES = 3;

function buildPrompt(rules: RuleRecord[], intent: string, areas: PatternsModel["areas"]): string {
  const areaLines = areas.map((a) => `${a.path} (${a.stack.join("/")}, ${a.recencyScore})`);
  const ruleLines = rules.map((r) => `[${r.id}] ${r.statement} (${r.score}, ${r.verdict}, ${r.category})`);
  return [`intent: ${intent}`, "", "areas:", ...areaLines, "", "rules:", ...ruleLines].join("\n");
}

function dropUnknownAndDuplicates(sections: DocPlanSection[], knownIds: Set<string>): { sections: DocPlanSection[]; seen: Set<string> } {
  const seen = new Set<string>();
  const cleaned = sections
    .map((s) => ({
      heading: s.heading,
      ruleIds: s.ruleIds.filter((id) => {
        if (!knownIds.has(id)) return false;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }),
    }))
    .filter((s) => s.ruleIds.length > 0);
  return { sections: cleaned, seen };
}

function rescueOmitted(sections: DocPlanSection[], rules: RuleRecord[], seen: Set<string>): DocPlanSection[] {
  const rescued = rules
    .filter((r) => !seen.has(r.id) && r.score >= RESCUE_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  if (rescued.length === 0) return sections;

  const out = sections.map((s) => ({ heading: s.heading, ruleIds: [...s.ruleIds] }));
  const existing = out.find((s) => s.heading === OTHER_CONVENTIONS_HEADING);
  if (existing) {
    existing.ruleIds.push(...rescued.map((r) => r.id));
  } else {
    out.push({ heading: OTHER_CONVENTIONS_HEADING, ruleIds: rescued.map((r) => r.id) });
  }
  return out;
}

function estimateLines(sections: DocPlanSection[]): number {
  return HEADER_LINES + sections.reduce((sum, s) => sum + SECTION_OVERHEAD_LINES + s.ruleIds.length, 0);
}

function trimToBudget(sections: DocPlanSection[], ruleById: Map<string, RuleRecord>): DocPlanSection[] {
  let current = sections.map((s) => ({ heading: s.heading, ruleIds: [...s.ruleIds] }));

  while (estimateLines(current) > LINE_BUDGET) {
    let largestIndex = -1;
    let largestSize = -1;
    for (let i = 0; i < current.length; i++) {
      const size = current[i]!.ruleIds.length;
      if (size > largestSize) {
        largestSize = size;
        largestIndex = i;
      }
    }
    if (largestIndex === -1 || largestSize <= 0) break; // nothing left to trim; terminates the loop

    const section = current[largestIndex]!;
    let lowestIndex = -1;
    let lowestScore = Infinity;
    for (let i = 0; i < section.ruleIds.length; i++) {
      const score = ruleById.get(section.ruleIds[i]!)!.score;
      if (score < lowestScore) {
        lowestScore = score;
        lowestIndex = i;
      }
    }
    section.ruleIds.splice(lowestIndex, 1);
    current = current.filter((s) => s.ruleIds.length > 0);
  }

  return current;
}

function enforce(draft: DocPlan, rules: RuleRecord[]): DocPlan {
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const knownIds = new Set(rules.map((r) => r.id));

  const { sections: deduped, seen } = dropUnknownAndDuplicates(draft.sections, knownIds);
  const rescued = rescueOmitted(deduped, rules, seen);
  const trimmed = trimToBudget(rescued, ruleById);

  return { ...draft, sections: trimmed };
}

export async function planDoc(
  rules: RuleRecord[],
  intent: string,
  areas: PatternsModel["areas"],
  provider: ModelProvider,
): Promise<DocPlan> {
  const draft = await provider.complete({
    system: SYSTEM,
    prompt: buildPrompt(rules, intent, areas),
    schema: DocPlanSchema,
    maxTokens: 4096,
  });

  return enforce(draft, rules);
}
