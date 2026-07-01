import { appendFile, readFile } from "node:fs/promises";

export class CorruptStateError extends Error {
  constructor(readonly file: string, readonly line: number) {
    super(`corrupt JSONL at ${file}:${line}`);
    this.name = "CorruptStateError";
  }
}

export async function appendJsonl(path: string, record: unknown): Promise<void> {
  await appendFile(path, JSON.stringify(record) + "\n", "utf8");
}

export async function readJsonl<T>(
  path: string,
  parse: (raw: unknown) => T,
  keyOf: (item: T) => string | number,
): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = text.split("\n");
  const lastContentIdx = lines.length - (lines.at(-1) === "" ? 2 : 1);
  const seen = new Map<string | number, T>();
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (i === lastContentIdx) continue; // torn trailing write from a crash
      throw new CorruptStateError(path, i + 1);
    }
    const item = parse(value);
    seen.set(keyOf(item), item); // last write wins
  }
  return [...seen.values()];
}
