import { z } from "zod";
import { BudgetExceededError, type ModelProvider } from "../model/provider.js";
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

// Returns the surviving sections PLUS the ids it had to remove to hit budget —
// callers must not let those ids vanish silently (see the "Fix" test in
// synthesize.test.ts): a rule cut here is genuinely known-good content, just
// too much of it for one document, so it belongs in the compact tail rather
// than disappearing from the rendered doc while its provenance still claims
// full-tier treatment.
function trimToBudget(
  sections: DocPlanSection[],
  ruleById: Map<string, RuleRecord>,
): { sections: DocPlanSection[]; trimmedIds: string[] } {
  let current = sections.map((s) => ({ heading: s.heading, ruleIds: [...s.ruleIds] }));
  const trimmedIds: string[] = [];

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
    trimmedIds.push(section.ruleIds[lowestIndex]!);
    section.ruleIds.splice(lowestIndex, 1);
    current = current.filter((s) => s.ruleIds.length > 0);
  }

  return { sections: current, trimmedIds };
}

export interface PlanResult {
  plan: DocPlan;
  // Ids trimToBudget removed from every section to fit the 400-line cap. The
  // caller (synthesize.ts) owns routing these into the compact tail and
  // correcting their renderedTier — enforce() only knows about sections, not
  // the tiering concept.
  trimmedIds: string[];
}

function enforce(draft: DocPlan, rules: RuleRecord[]): PlanResult {
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const knownIds = new Set(rules.map((r) => r.id));

  const { sections: deduped, seen } = dropUnknownAndDuplicates(draft.sections, knownIds);
  const rescued = rescueOmitted(deduped, rules, seen);
  const { sections: trimmed, trimmedIds } = trimToBudget(rescued, ruleById);

  return { plan: { ...draft, sections: trimmed }, trimmedIds };
}

// Deterministic degradation, mirroring cluster/reconcile: if the model is unavailable at this
// last step, emit a single score-desc section rather than failing after all the expensive work.
function fallbackDraft(rules: RuleRecord[]): DocPlan {
  const ruleIds = [...rules].sort((a, b) => b.score - a.score).map((r) => r.id);
  return {
    title: "Project conventions",
    overview: "",
    sections: [{ heading: "Conventions", ruleIds }],
    perArea: false,
  };
}

export async function planDoc(
  rules: RuleRecord[],
  intent: string,
  areas: PatternsModel["areas"],
  provider: ModelProvider,
): Promise<PlanResult> {
  let draft: DocPlan;
  try {
    draft = await provider.complete({
      system: SYSTEM,
      prompt: buildPrompt(rules, intent, areas),
      schema: DocPlanSchema,
      maxTokens: 4096,
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    draft = fallbackDraft(rules);
  }

  return enforce(draft, rules);
}
