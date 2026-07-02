import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { graphql } from "@octokit/graphql";

export type GqlTransport = <T>(
  query: string,
  variables: Record<string, unknown>,
) => Promise<T>;

const execFileAsync = promisify(execFile);
type GhTokenRunner = () => Promise<string>;

const defaultGhToken: GhTokenRunner = async () => {
  const { stdout } = await execFileAsync("gh", ["auth", "token"]);
  return stdout.trim();
};

export async function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
  ghToken: GhTokenRunner = defaultGhToken,
): Promise<string> {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  try {
    const token = await ghToken();
    if (token) return token;
  } catch {
    // fall through to the actionable error below
  }
  throw new Error("no GitHub token available: set GITHUB_TOKEN or run `gh auth login`");
}

// Default endpoint composes as baseUrl ("https://api.github.com") + "/graphql" =>
// "https://api.github.com/graphql". For GitHub Enterprise Server, pass
// baseUrl: "https://<host>/api" -- it composes the same way to "https://<host>/api/graphql"
// (a separate /api/v3 suffix regex in @octokit/graphql also normalizes that convention to the
// same result, but plain "https://<host>/api" already lands correctly via baseUrl + url).
export function makeTransport(token: string, baseUrl?: string): GqlTransport {
  const client = graphql.defaults({
    ...(baseUrl ? { baseUrl } : {}),
    headers: { authorization: `token ${token}` },
  });
  return <T>(query: string, variables: Record<string, unknown>) =>
    client<T>(query, variables);
}

interface RetryOpts {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(err: unknown): number | null {
  const e = err as { status?: number; response?: { headers?: Record<string, string> } };
  if (e?.status !== 403 && e?.status !== 429) return null;
  const header = e.response?.headers?.["retry-after"];
  const seconds = header ? Number(header) : 60;
  return (Number.isFinite(seconds) ? seconds : 60) * 1000 + Math.floor(Math.random() * 1000);
}

export function withRetry(transport: GqlTransport, opts: RetryOpts = {}): GqlTransport {
  const { maxAttempts = 3, sleep = defaultSleep } = opts;
  return async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await transport<T>(query, variables);
      } catch (err) {
        const wait = retryAfterMs(err);
        if (wait === null) throw err;
        lastErr = err;
        if (attempt < maxAttempts) await sleep(wait);
      }
    }
    throw lastErr;
  };
}

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

const PREFLIGHT_QUERY = `query preflight($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) { nameWithOwner }
}`;

export async function preflight(
  transport: GqlTransport,
  owner: string,
  name: string,
): Promise<void> {
  let res: { repository: { nameWithOwner: string } | null };
  try {
    res = await transport(PREFLIGHT_QUERY, { owner, name });
  } catch (err) {
    throw new PreflightError(
      `GitHub auth/connectivity check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.repository) {
    throw new PreflightError(`repository ${owner}/${name} not found or not accessible`);
  }
}
