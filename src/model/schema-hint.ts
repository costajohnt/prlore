import { z, type ZodType } from "zod";

/**
 * Renders a zod schema's JSON Schema shape into a short instruction block so
 * model prompts actually show the field names/types they're expected to
 * produce. Without this, providers only validate against `schema` after the
 * fact — the model has to guess field names from prose, and guesses drift
 * (e.g. `areaDescriptions[].path` vs whatever synonym the model picks).
 *
 * Returns null (never throws) when a schema can't be converted — some zod
 * types (custom validators, transforms) have no JSON Schema representation.
 * A missing hint should never crash a completion; the raw prompt still works,
 * just without the extra structural nudge.
 */
export function renderSchemaHint(schema: ZodType): string | null {
  try {
    const jsonSchema = z.toJSONSchema(schema);
    return `Your reply MUST be a single JSON object valid against this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
  } catch {
    return null;
  }
}

/**
 * Appends the schema hint (when renderable) to a prompt/input string. Shared
 * by both providers so the append logic — and its behavior when the hint is
 * null — lives in one place instead of being duplicated per provider.
 */
export function appendSchemaHint(text: string, schema: ZodType): string {
  const hint = renderSchemaHint(schema);
  return hint ? `${text}\n\n${hint}` : text;
}
