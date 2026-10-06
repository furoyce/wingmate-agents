import type { LinearIssue } from "../ports";

// Linear priority: 1 urgent … 4 low, 0 = none (sorted last); ties by age, then identifier for determinism.
const ORDER: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3, 0: 4 };

export const orderCandidates = (issues: LinearIssue[]): LinearIssue[] =>
  [...issues].sort(
    (a, b) =>
      (ORDER[a.priority] ?? 4) - (ORDER[b.priority] ?? 4) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.identifier.localeCompare(b.identifier),
  );
