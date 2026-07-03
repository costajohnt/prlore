import type { Association } from "../schemas/normalized-pr.js";

// The GitHub author associations treated as "high authority" for evidence
// weighting — repo owners, org members, and collaborators, as opposed to a
// mere CONTRIBUTOR or an outside commenter. Shared by verify-evidence.ts
// (authority rank for cross-part quote binding), score.ts (authority weight
// in rule scoring), and reconcile.ts (recent-high-authority-evidence gate for
// stale demotion) — all three used to hardcode their own copy of this exact
// set.
export const HIGH_AUTHORITY = new Set<Association>(["OWNER", "MEMBER", "COLLABORATOR"]);
