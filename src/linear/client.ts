// src/linear/client.ts — LinearPort over GraphQL: exact queries/mutations, pagination, DTO mapping.
import type { LinearComment, LinearHistoryEntry, LinearIssue, LinearPort, LinearTeamMeta } from "../ports";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";
import { TokenStore } from "./auth";
import { GraphQL } from "./graphql";

const ISSUE_FIELDS = `fragment IssueFields on Issue { id identifier title description url createdAt updatedAt archivedAt trashed priority branchName
  state { id name type } project { id } team { id key } assignee { id } delegate { id }
  labels { nodes { id name parent { id name } } } subscribers { nodes { id } } parent { id identifier }
  children { nodes { id identifier state { type } } } inverseRelations { nodes { type issue { id identifier state { type } } } }
  attachments { nodes { id url title } } }`;

type Node = Record<string, unknown>;
type Page<K extends string, N> = {
  [P in K]: { nodes: N[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Node => (v && typeof v === "object" ? (v as Node) : {});
const idOf = (v: unknown): string | null => (v && typeof v === "object" ? str(obj(v).id) : null);
const nodesOf = (n: Node, k: string): Node[] => (obj(n[k]).nodes as Node[] | undefined) ?? [];
const toLabel = (l: Node) => ({
  id: str(l.id),
  name: str(l.name),
  parentId: idOf(l.parent),
  parentName: l.parent ? str(obj(l.parent).name) : null,
});

const toIssue = (n: Node): LinearIssue => ({
  id: str(n.id),
  identifier: str(n.identifier),
  title: str(n.title),
  description: strOrNull(n.description),
  url: str(n.url),
  createdAt: str(n.createdAt),
  updatedAt: str(n.updatedAt),
  archivedAt: strOrNull(n.archivedAt),
  trashed: n.trashed === true,
  priority: typeof n.priority === "number" ? n.priority : 0,
  branchName: str(n.branchName),
  state: { id: str(obj(n.state).id), name: str(obj(n.state).name), type: str(obj(n.state).type) },
  projectId: idOf(n.project),
  teamId: str(obj(n.team).id),
  assigneeId: idOf(n.assignee),
  delegateId: idOf(n.delegate),
  labels: nodesOf(n, "labels").map(toLabel),
  subscriberIds: nodesOf(n, "subscribers").map((s) => str(s.id)),
  parent: n.parent ? { id: str(obj(n.parent).id), identifier: str(obj(n.parent).identifier) } : null,
  children: nodesOf(n, "children").map((c) => ({
    id: str(c.id),
    identifier: str(c.identifier),
    stateType: str(obj(c.state).type),
  })),
  // Only `blocks` relations are prerequisites (§5.3); `related`/`duplicate` never gate a claim.
  prerequisites: nodesOf(n, "inverseRelations")
    .filter((r) => r.type === "blocks")
    .map((r) => ({
      id: str(obj(r.issue).id),
      identifier: str(obj(r.issue).identifier),
      stateType: str(obj(obj(r.issue).state).type),
    })),
  attachments: nodesOf(n, "attachments").map((a) => ({
    id: str(a.id),
    url: str(a.url),
    title: str(a.title),
  })),
});

const toComment = (c: Node): LinearComment => ({
  id: str(c.id),
  issueId: str(obj(c.issue).id),
  body: str(c.body),
  createdAt: str(c.createdAt),
  parentId: idOf(c.parent),
  userId: idOf(c.user),
  botActorId: idOf(c.botActor),
  externalUserId: idOf(c.externalUser),
});

const toHistory = (h: Node): LinearHistoryEntry => ({
  id: str(h.id),
  createdAt: str(h.createdAt),
  actorId: idOf(h.actor),
  botActorId: idOf(h.botActor),
  botActorType: h.botActor ? str(obj(h.botActor).type) : null,
  addedLabelIds: (h.addedLabelIds as string[] | null | undefined) ?? [],
  removedLabelIds: (h.removedLabelIds as string[] | null | undefined) ?? [],
  fromStateId: strOrNull(h.fromStateId),
  toStateId: strOrNull(h.toStateId),
});

export class LinearClient implements LinearPort {
  /** Public so install-only helpers (saved views, Task 12) can issue queries without widening the port. */
  constructor(readonly g: GraphQL) {}

  static fromCredentials(dirs: Dirs, clock: Clock, fetchImpl: typeof fetch = fetch): LinearClient {
    return new LinearClient(new GraphQL(new TokenStore(dirs, clock, fetchImpl), fetchImpl));
  }

  private async pageIssues(filter: Record<string, unknown>): Promise<LinearIssue[]> {
    const out: LinearIssue[] = [];
    let after: string | null = null;
    do {
      const d: Page<"issues", Node> = await this.g.query(
        `${ISSUE_FIELDS} query Issues($filter: IssueFilter!, $after: String) { issues(first: 50, after: $after, filter: $filter) { nodes { ...IssueFields } pageInfo { hasNextPage endCursor } } }`,
        { filter, after },
      );
      out.push(...d.issues.nodes.map(toIssue));
      after = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  listCandidates(projectIds: string[], labelNames: string[]): Promise<LinearIssue[]> {
    return this.pageIssues({
      project: { id: { in: projectIds } },
      state: { type: { eq: "unstarted" } },
      labels: { name: { in: labelNames } },
    });
  }

  listUpdatedSince(projectIds: string[], sinceIso: string): Promise<LinearIssue[]> {
    return this.pageIssues({ project: { id: { in: projectIds } }, updatedAt: { gt: sinceIso } });
  }

  getIssues(ids: string[]): Promise<LinearIssue[]> {
    return ids.length ? this.pageIssues({ id: { in: ids } }) : Promise.resolve([]);
  }

  async listComments(issueIds: string[], sinceIso: string): Promise<LinearComment[]> {
    if (!issueIds.length) return [];
    const out: LinearComment[] = [];
    let after: string | null = null;
    do {
      const d: Page<"comments", Node> = await this.g.query(
        "query Comments($filter: CommentFilter!, $after: String) { comments(first: 100, after: $after, filter: $filter) { nodes { id body createdAt parent { id } issue { id } user { id } botActor { id } externalUser { id } } pageInfo { hasNextPage endCursor } } }",
        { filter: { issue: { id: { in: issueIds } }, createdAt: { gt: sinceIso } }, after },
      );
      out.push(...d.comments.nodes.map(toComment));
      after = d.comments.pageInfo.hasNextPage ? d.comments.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async issueHistory(issueId: string, sinceIso: string): Promise<LinearHistoryEntry[]> {
    const d: { issue: { history: { nodes: Node[] } } } = await this.g.query(
      "query History($id: String!) { issue(id: $id) { history(first: 50) { nodes { id createdAt actor { id } botActor { id type } addedLabelIds removedLabelIds fromStateId toStateId } } } }",
      { id: issueId },
    );
    return d.issue.history.nodes.filter((h) => str(h.createdAt) > sinceIso).map(toHistory);
  }

  async teamMeta(teamKey: string): Promise<LinearTeamMeta> {
    const d: {
      teams: { nodes: { states: { nodes: Node[] }; labels: { nodes: Node[] } }[] };
      issueLabels: { nodes: Node[] };
    } = await this.g.query(
      "query Meta($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { states { nodes { id name type } } labels { nodes { id name parent { id name } } } } } issueLabels(first: 250, filter: { team: { null: true } }) { nodes { id name parent { id name } } } }",
      { key: teamKey },
    );
    const t = d.teams.nodes[0];
    return {
      states: (t?.states.nodes ?? []).map((s) => ({ id: str(s.id), name: str(s.name), type: str(s.type) })),
      labels: [...(t?.labels.nodes ?? []), ...d.issueLabels.nodes].map(toLabel),
    };
  }

  async updateIssue(
    id: string,
    input: { stateId?: string; labelIds?: string[]; subscriberIds?: string[] },
  ): Promise<void> {
    await this.g.query(
      "mutation U($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      { id, input },
    );
  }

  async createComment(
    issueId: string,
    body: string,
    opts: { id: string; parentId?: string },
  ): Promise<{ id: string }> {
    const d: { commentCreate: { comment: { id: string } } } = await this.g.query(
      "mutation C($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
      { input: { id: opts.id, issueId, body, ...(opts.parentId ? { parentId: opts.parentId } : {}) } },
    );
    return { id: d.commentCreate.comment.id };
  }

  async updateComment(id: string, body: string): Promise<void> {
    await this.g.query(
      "mutation CU($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { success } }",
      { id, body },
    );
  }

  async createAttachment(issueId: string, url: string, title: string): Promise<void> {
    await this.g.query(
      "mutation A($issueId: String!, $url: String!, $title: String!) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }",
      { issueId, url, title },
    );
  }

  async createIssue(input: {
    id: string;
    teamId: string;
    projectId: string | null;
    parentId: string;
    title: string;
    description: string;
    stateId: string;
  }): Promise<{ id: string; identifier: string }> {
    const { projectId, ...rest } = input;
    const d: { issueCreate: { issue: { id: string; identifier: string } } } = await this.g.query(
      "mutation I($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }",
      { input: { ...rest, ...(projectId ? { projectId } : {}) } },
    );
    return d.issueCreate.issue;
  }

  async subscribe(issueId: string, userId: string): Promise<void> {
    await this.g.query(
      "mutation S($id: String!, $userId: String!) { issueSubscribe(id: $id, userId: $userId) { success } }",
      { id: issueId, userId },
    );
  }
}
