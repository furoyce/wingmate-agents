// src/linear/markers.ts — HTML-comment markers that make Wingmate's own comments recognizable on re-read.
export const MARK = {
  status: "<!-- wingmate:status -->",
  question: (id: string) => `<!-- wingmate:question id=${id} -->`,
  blocked: "<!-- wingmate:blocked -->",
  followup: (of: string) => `<!-- wingmate:followup of=${of} -->`,
  handoff: "<!-- wingmate:handoff -->",
  completion: "<!-- wingmate:completion -->",
} as const;

export const findMarked = <T extends { body: string }>(comments: T[], marker: string): T | undefined =>
  comments.find((c) => c.body.startsWith(marker));

export const parseQuestionId = (body: string): string | null =>
  /^<!-- wingmate:question id=([0-9A-Z]+) -->/.exec(body)?.[1] ?? null;
