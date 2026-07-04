import { expect, test } from "vitest";
import { z } from "zod";
import { appendSchemaHint, renderSchemaHint } from "../src/model/schema-hint.js";

test("renders a JSON Schema hint containing the field names of a nested object/array schema", () => {
  const schema = z.object({
    areaDescriptions: z.array(z.object({ path: z.string(), description: z.string() })),
  });
  const hint = renderSchemaHint(schema);
  expect(hint).not.toBeNull();
  expect(hint).toContain("areaDescriptions");
  expect(hint).toContain("path");
  expect(hint).toContain("description");
  expect(hint).toContain("JSON Schema");
});

test("returns null (never throws) for a schema zod cannot convert to JSON Schema", () => {
  // z.custom() has no JSON Schema representation — zod 4's toJSONSchema throws
  // "Custom types cannot be represented in JSON Schema" for it.
  const schema = z.custom<string>(() => true);
  expect(() => renderSchemaHint(schema)).not.toThrow();
  expect(renderSchemaHint(schema)).toBeNull();
});

test("appendSchemaHint appends the hint when renderable", () => {
  const schema = z.object({ answer: z.string() });
  const out = appendSchemaHint("base prompt", schema);
  expect(out).toContain("base prompt");
  expect(out).toContain("answer");
  expect(out).toContain("JSON Schema");
});

test("appendSchemaHint returns the original text unchanged when the hint can't be rendered", () => {
  const schema = z.custom<string>(() => true);
  const out = appendSchemaHint("base prompt", schema);
  expect(out).toBe("base prompt");
});
