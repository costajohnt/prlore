import { z } from "zod";

export const AssociationSchema = z.enum([
  "OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", "NONE",
]);
export type Association = z.infer<typeof AssociationSchema>;

export const CommentSchema = z.object({
  author: z.string(),
  association: AssociationSchema,
  body: z.string(),
  createdAt: z.string(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const ReviewThreadSchema = z.object({
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  resolved: z.boolean(),
  comments: z.array(CommentSchema),
});

export const NormalizedPrSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().default(""),
  author: z.string(),
  authorAssociation: AssociationSchema,
  state: z.enum(["MERGED", "CLOSED", "OPEN"]),
  mergedAt: z.string().nullable(),
  updatedAt: z.string(),
  labels: z.array(z.string()),
  files: z.array(z.string()),
  threads: z.array(ReviewThreadSchema),
  reviews: z.array(z.object({
    author: z.string(),
    association: AssociationSchema,
    state: z.string(),
    body: z.string(),
  })),
  comments: z.array(CommentSchema),
});
export type NormalizedPr = z.infer<typeof NormalizedPrSchema>;
