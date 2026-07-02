import { expect, test } from "vitest";
import { setupServer } from "msw/node";
import { HttpResponse, http } from "msw";
import {
  PreflightError,
  makeTransport,
  preflight,
  resolveToken,
  withRetry,
} from "../src/github/client.js";

test("resolveToken prefers GITHUB_TOKEN and never shells out when set", async () => {
  expect(await resolveToken({ GITHUB_TOKEN: "gho_test_fake" } as NodeJS.ProcessEnv)).toBe(
    "gho_test_fake",
  );
});

test("resolveToken throws a clear error when nothing is available", async () => {
  await expect(
    resolveToken({} as NodeJS.ProcessEnv, async () => {
      throw new Error("gh not installed");
    }),
  ).rejects.toThrow(/GITHUB_TOKEN|gh auth/);
});

test("makeTransport posts to the GraphQL endpoint with auth header (msw)", async () => {
  let sawAuth = "";
  const server = setupServer(
    http.post("https://api.github.com/graphql", async ({ request }) => {
      sawAuth = request.headers.get("authorization") ?? "";
      return HttpResponse.json({ data: { viewer: { login: "octocat" } } });
    }),
  );
  server.listen({ onUnhandledRequest: "error" });
  try {
    const transport = makeTransport("gho_test_fake");
    const res = await transport<{ viewer: { login: string } }>("query { viewer { login } }", {});
    expect(res.viewer.login).toBe("octocat");
    expect(sawAuth).toMatch(/gho_test_fake/);
  } finally {
    server.close();
  }
});

test("withRetry retries once on a retry-after error, sleeping the stated seconds", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const flaky = (async () => {
    calls++;
    if (calls === 1) {
      const err = new Error("rate limited") as Error & {
        status?: number;
        response?: { headers?: Record<string, string> };
      };
      err.status = 403;
      err.response = { headers: { "retry-after": "7" } };
      throw err;
    }
    return { ok: true };
  }) as unknown as Parameters<typeof withRetry>[0];
  const wrapped = withRetry(flaky, { sleep: async (ms) => void sleeps.push(ms) });
  expect(await wrapped("query {}", {})).toEqual({ ok: true });
  expect(calls).toBe(2);
  expect(sleeps[0]).toBeGreaterThanOrEqual(7000);
});

test("withRetry gives up after 3 attempts and rethrows non-rate errors immediately", async () => {
  let calls = 0;
  const alwaysRate = (async () => {
    calls++;
    const err = new Error("nope") as Error & { status?: number };
    err.status = 429;
    throw err;
  }) as unknown as Parameters<typeof withRetry>[0];
  const wrapped = withRetry(alwaysRate, { sleep: async () => {} });
  await expect(wrapped("q", {})).rejects.toThrow("nope");
  expect(calls).toBe(3);

  let plainCalls = 0;
  const plainFail = (async () => {
    plainCalls++;
    throw new Error("schema error");
  }) as unknown as Parameters<typeof withRetry>[0];
  await expect(withRetry(plainFail, { sleep: async () => {} })("q", {})).rejects.toThrow(
    "schema error",
  );
  expect(plainCalls).toBe(1);
});

test("withRetry retries a primary RATE_LIMITED GraphqlResponseError using x-ratelimit-reset", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const flaky = (async () => {
    calls++;
    if (calls === 1) {
      const err = {
        errors: [{ type: "RATE_LIMITED" }],
        headers: { "x-ratelimit-reset": "5" },
      };
      throw err;
    }
    return { ok: true };
  }) as unknown as Parameters<typeof withRetry>[0];
  const wrapped = withRetry(flaky, {
    sleep: async (ms) => void sleeps.push(ms),
    now: () => 0,
  });
  expect(await wrapped("query {}", {})).toEqual({ ok: true });
  expect(calls).toBe(2);
  expect(sleeps[0]).toBeGreaterThanOrEqual(5000);
});

test("withRetry falls back to a 60s wait for a RATE_LIMITED error with no reset header", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const flaky = (async () => {
    calls++;
    if (calls === 1) {
      const err = { errors: [{ type: "RATE_LIMITED" }], headers: {} };
      throw err;
    }
    return { ok: true };
  }) as unknown as Parameters<typeof withRetry>[0];
  const wrapped = withRetry(flaky, {
    sleep: async (ms) => void sleeps.push(ms),
    now: () => 0,
  });
  expect(await wrapped("query {}", {})).toEqual({ ok: true });
  expect(calls).toBe(2);
  expect(sleeps[0]).toBeGreaterThanOrEqual(60000);
});

test("preflight throws PreflightError when the repository is inaccessible", async () => {
  const transport = (async () => ({ viewer: { login: "octocat" }, repository: null })) as never;
  await expect(preflight(transport, "owner", "gone")).rejects.toThrow(PreflightError);
});
