import type { History } from "./collect.js";

export interface Area {
  path: string;
  files: string[];
  stack: string[];
  recencyScore: number;
  churn: number;
}

const NESTED_ROOTS = new Set(["src", "lib", "packages", "apps"]);

function areaKey(file: string): string {
  const parts = file.split("/");
  if (parts.length === 1) return ".";
  if (NESTED_ROOTS.has(parts[0]!) && parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  return parts[0]!;
}

function extension(file: string): string {
  const idx = file.lastIndexOf(".");
  return idx > file.lastIndexOf("/") ? file.slice(idx) : "";
}

export function detectAreas(history: History, opts: { minFiles?: number } = {}): Area[] {
  const minFiles = opts.minFiles ?? 2;
  const groups = new Map<string, string[]>();
  for (const f of history.files) {
    const key = areaKey(f);
    if (key === ".") continue;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }

  const areas: Area[] = [];
  for (const [path, files] of groups) {
    if (files.length < minFiles) continue;
    const extCounts = new Map<string, number>();
    for (const f of files) {
      const ext = extension(f);
      if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }
    const stack = [...extCounts.entries()]
      .filter(([, n]) => n / files.length >= 0.2)
      .sort((a, b) => b[1] - a[1])
      .map(([ext]) => ext);
    const recencyScore =
      files.reduce((sum, f) => sum + (history.recencyPercentile.get(f) ?? 0), 0) / files.length;
    const churn = files.reduce((sum, f) => sum + (history.commitCount.get(f) ?? 0), 0);
    areas.push({ path, files, stack, recencyScore, churn });
  }
  return areas.sort((a, b) => b.recencyScore - a.recencyScore);
}

const TOTAL_EXEMPLAR_CAP = 25;

export function pickExemplars(
  areas: Area[],
  history: History,
  focusAreas: string[] = [],
): { area: string; path: string }[] {
  const focusPrefixes = focusAreas.map((f) => f.replace(/\/\*\*?$/, ""));
  const perArea = areas.map((area) => {
    const focused = focusPrefixes.some((p) => area.path === p || area.path.startsWith(`${p}/`));
    const k = focused ? 8 : 5;
    const ranked = [...area.files].sort(
      (a, b) =>
        (history.recencyPercentile.get(b) ?? 0) * (1 + (history.commitCount.get(b) ?? 0)) -
        (history.recencyPercentile.get(a) ?? 0) * (1 + (history.commitCount.get(a) ?? 0)),
    );
    return ranked.slice(0, k).map((path) => ({ area: area.path, path }));
  });

  // round-robin across areas so the global cap trims evenly, not area-by-area
  const result: { area: string; path: string }[] = [];
  for (let i = 0; result.length < TOTAL_EXEMPLAR_CAP; i++) {
    let added = false;
    for (const list of perArea) {
      if (i < list.length && result.length < TOTAL_EXEMPLAR_CAP) {
        result.push(list[i]!);
        added = true;
      }
    }
    if (!added) break;
  }
  return result;
}
