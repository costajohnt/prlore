// Regression tests for audit 2026-11-07 H1: a mined checkout must not be able to
// redirect prlore's state writes through checked-in symlinks.
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { JobManager, type JobDeps } from "../src/jobs/manager.js";
import { atomicWriteFile } from "../src/state/atomic.js";
import { MineConfigSchema } from "../src/schemas/mine-config.js";

const tmp = () => mkdtemp(join(tmpdir(), "prlore-h1-"));

test("atomicWriteFile does not write through a pre-planted <path>.tmp symlink", async () => {
  const dir = await tmp();
  const victim = join(dir, "victim");
  await writeFile(victim, "precious", "utf8");
  const target = join(dir, "state", "checkpoint.json");
  await mkdir(join(dir, "state"));
  await symlink(victim, `${target}.tmp`);

  await atomicWriteFile(target, "{}");

  expect(await readFile(victim, "utf8")).toBe("precious");
  expect(await readFile(target, "utf8")).toBe("{}");
  // no stray random temp files left behind
  expect((await readdir(join(dir, "state"))).sort()).toEqual(["checkpoint.json", "checkpoint.json.tmp"]);
});

test("JobManager.start refuses a stateDir containing a symlink, before any write", async () => {
  const repo = await tmp();
  const victim = join(await tmp(), "victim");
  await writeFile(victim, "precious", "utf8");
  const stateDir = join(repo, ".prlore");
  await mkdir(stateDir);
  await symlink(victim, join(stateDir, "corpus.jsonl"));

  const config = MineConfigSchema.parse({ repo: "o/r", intent: "test", timeRange: { since: "2026-01-01T00:00:00Z" } });
  const deps = { transport: {}, provider: {}, stateDir, repoPath: repo } as unknown as JobDeps;
  expect(() => new JobManager().start(config, deps)).toThrow(/symlink/);
  expect(await readFile(victim, "utf8")).toBe("precious");
});

test("JobManager.start refuses a stateDir that is itself a symlink", async () => {
  const repo = await tmp();
  const elsewhere = await tmp();
  await symlink(elsewhere, join(repo, ".prlore"));

  const config = MineConfigSchema.parse({ repo: "o/r", intent: "test", timeRange: { since: "2026-01-01T00:00:00Z" } });
  const deps = { transport: {}, provider: {}, stateDir: join(repo, ".prlore"), repoPath: repo } as unknown as JobDeps;
  expect(() => new JobManager().start(config, deps)).toThrow(/symlink/);
  expect(await readdir(elsewhere)).toEqual([]);
});
