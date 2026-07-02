import type { Association, NormalizedPr } from "../schemas/normalized-pr.js";

export interface RawActor {
  login: string;
  __typename: string;
}
interface RawPageInfo {
  hasNextPage: boolean;
}
export interface RawComment {
  author: RawActor | null;
  authorAssociation: Association;
  body: string;
  createdAt: string;
}
export interface RawReview {
  author: RawActor | null;
  authorAssociation: Association;
  state: string;
  body: string;
}
export interface RawThread {
  path: string | null;
  line: number | null;
  isResolved: boolean;
  comments: { nodes: RawComment[]; pageInfo: RawPageInfo };
}
export interface RawPrNode {
  number: number;
  title: string;
  body: string | null;
  updatedAt: string;
  mergedAt: string | null;
  state: "MERGED" | "CLOSED" | "OPEN";
  author: RawActor | null;
  authorAssociation: Association;
  labels: { nodes: { name: string }[] };
  files: { nodes: { path: string }[]; pageInfo: RawPageInfo };
  reviews: { nodes: RawReview[]; pageInfo: RawPageInfo };
  comments: { nodes: RawComment[]; pageInfo: RawPageInfo };
  reviewThreads: { nodes: RawThread[]; pageInfo: RawPageInfo };
}

export interface IngestCounters {
  botCommentsStripped: number;
}

export type NormalizeResult =
  | { kept: true; pr: NormalizedPr; needsOverflow: boolean }
  | { kept: false; reason: "no_human_discussion" };

function isBot(actor: RawActor | null): boolean {
  return actor !== null && (actor.__typename === "Bot" || actor.login.endsWith("[bot]"));
}

function actorLogin(actor: RawActor | null): string {
  return actor?.login ?? "ghost";
}

export function normalizePr(node: RawPrNode, counters: IngestCounters): NormalizeResult {
  const stripBots = <T extends { author: RawActor | null }>(items: T[]): T[] => {
    const kept = items.filter((i) => !isBot(i.author));
    counters.botCommentsStripped += items.length - kept.length;
    return kept;
  };

  const reviews = stripBots(node.reviews.nodes);
  const comments = stripBots(node.comments.nodes);
  const threads = node.reviewThreads.nodes.map((t) => ({
    ...t,
    comments: { ...t.comments, nodes: stripBots(t.comments.nodes) },
  }));

  const humanText =
    reviews.map((r) => r.body).join("") +
    comments.map((c) => c.body).join("") +
    threads.flatMap((t) => t.comments.nodes.map((c) => c.body)).join("");
  if (humanText.trim().length === 0) {
    return { kept: false, reason: "no_human_discussion" };
  }

  const needsOverflow =
    node.files.pageInfo.hasNextPage ||
    node.reviews.pageInfo.hasNextPage ||
    node.comments.pageInfo.hasNextPage ||
    node.reviewThreads.pageInfo.hasNextPage ||
    node.reviewThreads.nodes.some((t) => t.comments.pageInfo.hasNextPage);

  const pr: NormalizedPr = {
    number: node.number,
    title: node.title,
    body: node.body ?? "",
    author: actorLogin(node.author),
    authorAssociation: node.authorAssociation,
    state: node.state,
    mergedAt: node.mergedAt,
    updatedAt: node.updatedAt,
    labels: node.labels.nodes.map((l) => l.name),
    files: node.files.nodes.map((f) => f.path),
    threads: threads
      .filter((t) => t.comments.nodes.length > 0)
      .map((t) => ({
        path: t.path,
        line: t.line,
        resolved: t.isResolved,
        comments: t.comments.nodes.map((c) => ({
          author: actorLogin(c.author),
          association: c.authorAssociation,
          body: c.body,
          createdAt: c.createdAt,
        })),
      })),
    reviews: reviews.map((r) => ({
      author: actorLogin(r.author),
      association: r.authorAssociation,
      state: r.state,
      body: r.body,
    })),
    comments: comments.map((c) => ({
      author: actorLogin(c.author),
      association: c.authorAssociation,
      body: c.body,
      createdAt: c.createdAt,
    })),
  };

  return { kept: true, pr, needsOverflow };
}
