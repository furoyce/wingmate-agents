// tests/fakes/issues.ts — Linear issue builders shared by unit and simulation tests
import type { LinearIssue } from "../../src/ports";
import type { FakeLinear } from "./fakeLinear";

export const OWNER = "71aef180-1742-4a76-8d49-51f14e8ada1e";
export const BOUNCR = "0ca67822-6416-447b-b7b2-08ab2a7346dd";

/** A Bouncr Todo issue labeled `agent-ready`. */
export const todo = (id: string, identifier: string, over: Partial<LinearIssue> = {}): LinearIssue => ({
  id,
  identifier,
  title: "iOS leaderboard",
  description: "Add a leaderboard",
  url: `https://linear.app/jrf/issue/${identifier}`,
  createdAt: "2026-10-06T09:00:00.000Z",
  updatedAt: "2026-10-06T09:00:00.000Z",
  archivedAt: null,
  trashed: false,
  priority: 2,
  branchName: "b",
  state: { id: "st-todo", name: "Todo", type: "unstarted" },
  projectId: BOUNCR,
  teamId: "t",
  assigneeId: OWNER,
  delegateId: null,
  labels: [{ id: "lb-agent-ready", name: "agent-ready", parentId: "grp-agent", parentName: "Agent" }],
  subscriberIds: [],
  parent: null,
  children: [],
  prerequisites: [],
  attachments: [],
  ...over,
});

/** Adds the issue with a history in which the owner added its labels (the eligibility authorship rule). */
export function addLabeledByOwner(linear: FakeLinear, issue: LinearIssue): void {
  linear.add(issue);
  linear.history.set(issue.id, [
    {
      id: "h0",
      createdAt: issue.createdAt,
      actorId: OWNER,
      botActorId: null,
      botActorType: null,
      addedLabelIds: issue.labels.map((l) => l.id),
      removedLabelIds: [],
      fromStateId: null,
      toStateId: null,
    },
  ]);
}
