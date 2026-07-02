import { expect, test } from "vitest";
import { Throttle } from "../src/github/throttle.js";

function harness(startMs = 1_000_000) {
  let clock = startMs;
  const sleeps: number[] = [];
  const throttle = new Throttle({
    pointsPerMinute: 10,
    minRemaining: 100,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { throttle, sleeps, tick: (ms: number) => (clock += ms), rate: (r: Partial<{ cost: number; remaining: number; resetAt: string }>) => ({ cost: 1, remaining: 5000, resetAt: new Date(startMs + 3_600_000).toISOString(), ...r }) };
}

test("does not sleep while under the per-minute budget", async () => {
  const { throttle, sleeps, rate } = harness();
  await throttle.beforeRequest(2);
  await throttle.afterResponse(rate({ cost: 2 }));
  await throttle.beforeRequest(2);
  expect(sleeps).toEqual([]);
});

test("sleeps when the next request would exceed the per-minute budget, then proceeds", async () => {
  const { throttle, sleeps, rate } = harness();
  await throttle.beforeRequest(6);
  await throttle.afterResponse(rate({ cost: 6 }));
  await throttle.beforeRequest(6); // 6 spent + 6 estimated > 10 → must wait for window
  expect(sleeps.length).toBe(1);
  expect(sleeps[0]).toBeGreaterThan(0);
  expect(sleeps[0]).toBeLessThanOrEqual(60_000);
});

test("old spend falls out of the sliding window", async () => {
  const { throttle, sleeps, tick, rate } = harness();
  await throttle.beforeRequest(6);
  await throttle.afterResponse(rate({ cost: 6 }));
  tick(61_000); // window expires
  await throttle.beforeRequest(6);
  expect(sleeps).toEqual([]);
});

test("sleeps until resetAt when hourly remaining is low", async () => {
  const start = 1_000_000;
  const { throttle, sleeps, rate } = harness(start);
  const resetAt = new Date(start + 120_000).toISOString();
  await throttle.afterResponse(rate({ remaining: 50, resetAt }));
  expect(sleeps.length).toBe(1);
  expect(sleeps[0]).toBeGreaterThanOrEqual(120_000);
});
