// src/linear/client.ts — LinearPort over GraphQL: exact queries/mutations, cursor pagination, Zod-validated
// response shapes (identity fields required, everything else tolerant), DTO mapping.
import { z } from "zod";
import type { LinearComment, LinearHistoryEntry, LinearIssue, LinearPort, LinearTeamMeta } from "../ports";
import { WingmateError } from "../shared/errors";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";
import { TokenStore } from "./auth";
import { GraphQL } from "./graphql";

const ISSUE_FIELDS = `fragment IssueFields on Issue { id identifier title description url createdAt updatedAt archivedAt trashed priority branchName
  state { id name type } project { id } team { id key } assignee { id } delegate { id }
  labels { nodes { id name parent { id name } } } subscribers { nodes { id } } parent { id identifier }
  children { nodes { id identifier state { type } } } inverseRelations { nodes { type issue { id identifier state { type } } } }
  attachments { nodes { id url title } } }`;

// ---- response shapes: identity fields are required, the rest is nullish/passthrough ----------------------------
const Id = z.string().min(1);
const IdRef = z.object({ id: Id }).passthrough();
const Nodes = <S extends z.ZodTypeAny>(node: S) => z.object({ nodes: z.array(node) }).passthrough();
const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }).passthrough();
const Connection = <S extends z.ZodTypeAny>(node: S) =>
  z.object({ nodes: z.array(node), pageInfo: PageInfo }).passthrough();

const LabelNode = z
  .object({
    id: Id,
    name: z.string(),
    parent: z.object({ id: Id, name: z.string() }).passthrough().nullish(),
  })
  .passthrough();
const StateNode = z.object({ id: Id, name: z.string(), type: z.string() }).passthrough();
const IssueNode = z
  .object({
    id: Id,
    identifier: Id,
    title: z.string(),
    description: z.string().nullish(),
    url: z.string(),
    createdAt: Id,
    updatedAt: Id,
    archivedAt: z.string().nullish(),
    trashed: z.boolean().nullish(),
    priority: z.number().nullish(),
    branchName: z.string().nullish(),
    state: StateNode,
    project: IdRef.nullish(),
    team: IdRef,
    assignee: IdRef.nullish(),
    delegate: IdRef.nullish(),
    labels: Nodes(LabelNode).nullish(),
    subscribers: Nodes(IdRef).nullish(),
    parent: z.object({ id: Id, identifier: Id }).passthrough().nullish(),
    children: Nodes(
      z
        .object({ id: Id, identifier: Id, state: z.object({ type: z.string() }).passthrough().nullish() })
        .passthrough(),
    ).nullish(),
    inverseRelations: Nodes(
      z
        .object({
          type: z.string(),
          issue: z
            .object({ id: Id, identifier: Id, state: z.object({ type: z.string() }).passthrough().nullish() })
            .passthrough(),
        })
        .passthrough(),
    ).nullish(),
    attachments: Nodes(
      z.object({ id: Id, url: z.string(), title: z.string().nullish() }).passthrough(),
    ).nullish(),
  })
  .passthrough();
const CommentNode = z
  .object({
    id: Id,
    body: z.string(),
    createdAt: Id,
    parent: IdRef.nullish(),
    issue: IdRef,
    user: IdRef.nullish(),
    botActor: IdRef.nullish(),
    externalUser: IdRef.nullish(),
  })
  .passthrough();
const HistoryNode = z
  .object({
    id: Id,
    createdAt: Id,
    actor: IdRef.nullish(),
    botActor: z.object({ id: Id, type: z.string().nullish() }).passthrough().nullish(),
    addedLabelIds: z.array(z.string()).nullish(),
    removedLabelIds: z.array(z.string()).nullish(),
    fromStateId: z.string().nullish(),
    toStateId: z.string().nullish(),
  })
  .passthrough();
const IssuesPage = z.object({ issues: Connection(IssueNode) }).passthrough();
const CommentsPage = z.object({ comments: Connection(CommentNode) }).passthrough();
const HistoryPage = z
  .object({ issue: z.object({ history: Connection(HistoryNode) }).passthrough() })
  .passthrough();
const TeamMetaShape = z
  .object({
    teams: Nodes(z.object({ states: Nodes(StateNode), labels: Nodes(LabelNode) }).passthrough()),
    issueLabels: Nodes(LabelNode),
  })
  .passthrough();
const CommentCreated = z.object({ commentCreate: z.object({ comment: IdRef }).passthrough() }).passthrough();
const IssueCreated = z
  .object({
    issueCreate: z.object({ issue: z.object({ id: Id, identifier: Id }).passthrough() }).passthrough(),
  })
  .passthrough();

type IssueNodeT = z.infer<typeof IssueNode>;
type CommentNodeT = z.infer<typeof CommentNode>;
type HistoryNodeT = z.infer<typeof HistoryNode>;
type LabelNodeT = z.infer<typeof LabelNode>;

/** Validate a GraphQL `data` object; a missing identity field is `linear_shape` with the query and path, never "". */
const shaped = <S extends z.ZodTypeAny>(schema: S, value: unknown, query: string): z.infer<S> => {
  const r = schema.safeParse(value);
  if (r.success) return r.data as z.infer<S>;
  const i = r.error.issues[0];
  throw new WingmateError(
    "linear_shape",
    `${query}: ${i?.path.join(".") || "(root)"} ${i?.message ?? "invalid"}`,
  );
};

// ---- DTO mapping -------------------------------------------------------------------------------------------------
const toLabel = (l: LabelNodeT) => ({
  id: l.id,
  name: l.name,
  parentId: l.parent?.id ?? null,
  parentName: l.parent?.name ?? null,
});

const toIssue = (n: IssueNodeT): LinearIssue => ({
  id: n.id,
  identifier: n.identifier,
  title: n.title,
  description: n.description ?? null,
  url: n.url,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
  archivedAt: n.archivedAt ?? null,
  trashed: n.trashed === true,
  priority: n.priority ?? 0,
  branchName: n.branchName ?? "",
  state: { id: n.state.id, name: n.state.name, type: n.state.type },
  projectId: n.project?.id ?? null,
  teamId: n.team.id,
  assigneeId: n.assignee?.id ?? null,
  delegateId: n.delegate?.id ?? null,
  labels: (n.labels?.nodes ?? []).map(toLabel),
  subscriberIds: (n.subscribers?.nodes ?? []).map((s) => s.id),
  parent: n.parent ? { id: n.parent.id, identifier: n.parent.identifier } : null,
  children: (n.children?.nodes ?? []).map((c) => ({
    id: c.id,
    identifier: c.identifier,
    stateType: c.state?.type ?? "",
  })),
  // Only `blocks` relations are prerequisites (§5.3); `related`/`duplicate` never gate a claim.
  prerequisites: (n.inverseRelations?.nodes ?? [])
    .filter((r) => r.type === "blocks")
    .map((r) => ({ id: r.issue.id, identifier: r.issue.identifier, stateType: r.issue.state?.type ?? "" })),
  attachments: (n.attachments?.nodes ?? []).map((a) => ({ id: a.id, url: a.url, title: a.title ?? "" })),
});

const toComment = (c: CommentNodeT): LinearComment => ({
  id: c.id,
  issueId: c.issue.id,
  body: c.body,
  createdAt: c.createdAt,
  parentId: c.parent?.id ?? null,
  userId: c.user?.id ?? null,
  botActorId: c.botActor?.id ?? null,
  externalUserId: c.externalUser?.id ?? null,
});

const toHistory = (h: HistoryNodeT): LinearHistoryEntry => ({
  id: h.id,
  createdAt: h.createdAt,
  actorId: h.actor?.id ?? null,
  botActorId: h.botActor?.id ?? null,
  botActorType: h.botActor ? (h.botActor.type ?? null) : null,
  addedLabelIds: h.addedLabelIds ?? [],
  removedLabelIds: h.removedLabelIds ?? [],
  fromStateId: h.fromStateId ?? null,
  toStateId: h.toStateId ?? null,
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
      const d: z.infer<typeof IssuesPage> = shaped(
        IssuesPage,
        await this.g.query(
          `${ISSUE_FIELDS} query Issues($filter: IssueFilter!, $after: String) { issues(first: 50, after: $after, filter: $filter) { nodes { ...IssueFields } pageInfo { hasNextPage endCursor } } }`,
          { filter, after },
        ),
        "issues",
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

  /** `JRF-123` → the team-scoped issue number 123 of team `JRF`; null when the identifier names no issue. */
  async issueByIdentifier(identifier: string): Promise<LinearIssue | null> {
    const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(identifier);
    if (!m) return null;
    const found = await this.pageIssues({ team: { key: { eq: m[1] } }, number: { eq: Number(m[2]) } });
    return found.find((i) => i.identifier === identifier) ?? null;
  }

  async listComments(issueIds: string[], sinceIso: string): Promise<LinearComment[]> {
    if (!issueIds.length) return [];
    const out: LinearComment[] = [];
    let after: string | null = null;
    do {
      const d: z.infer<typeof CommentsPage> = shaped(
        CommentsPage,
        await this.g.query(
          "query Comments($filter: CommentFilter!, $after: String) { comments(first: 100, after: $after, filter: $filter) { nodes { id body createdAt parent { id } issue { id } user { id } botActor { id } externalUser { id } } pageInfo { hasNextPage endCursor } } }",
          { filter: { issue: { id: { in: issueIds } }, createdAt: { gt: sinceIso } }, after },
        ),
        "comments",
      );
      out.push(...d.comments.nodes.map(toComment));
      after = d.comments.pageInfo.hasNextPage ? d.comments.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  /** Whole history, oldest first, paged 50 at a time (per-issue history is small); filtered by `createdAt > since`. */
  async issueHistory(issueId: string, sinceIso: string): Promise<LinearHistoryEntry[]> {
    const out: LinearHistoryEntry[] = [];
    let after: string | null = null;
    do {
      const d: z.infer<typeof HistoryPage> = shaped(
        HistoryPage,
        await this.g.query(
          "query History($id: String!, $after: String) { issue(id: $id) { history(first: 50, after: $after, orderBy: createdAt) { nodes { id createdAt actor { id } botActor { id type } addedLabelIds removedLabelIds fromStateId toStateId } pageInfo { hasNextPage endCursor } } } }",
          { id: issueId, after },
        ),
        "history",
      );
      out.push(...d.issue.history.nodes.filter((h) => h.createdAt > sinceIso).map(toHistory));
      after = d.issue.history.pageInfo.hasNextPage ? d.issue.history.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async teamMeta(teamKey: string): Promise<LinearTeamMeta> {
    const d = shaped(
      TeamMetaShape,
      await this.g.query(
        "query Meta($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { states { nodes { id name type } } labels { nodes { id name parent { id name } } } } } issueLabels(first: 250, filter: { team: { null: true } }) { nodes { id name parent { id name } } } }",
        { key: teamKey },
      ),
      "teamMeta",
    );
    const t = d.teams.nodes[0];
    return {
      states: (t?.states.nodes ?? []).map((s) => ({ id: s.id, name: s.name, type: s.type })),
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
    const d = shaped(
      CommentCreated,
      await this.g.query(
        "mutation C($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
        { input: { id: opts.id, issueId, body, ...(opts.parentId ? { parentId: opts.parentId } : {}) } },
      ),
      "commentCreate",
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
    const d = shaped(
      IssueCreated,
      await this.g.query(
        "mutation I($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }",
        { input: { ...rest, ...(projectId ? { projectId } : {}) } },
      ),
      "issueCreate",
    );
    return { id: d.issueCreate.issue.id, identifier: d.issueCreate.issue.identifier };
  }

  async subscribe(issueId: string, userId: string): Promise<void> {
    await this.g.query(
      "mutation S($id: String!, $userId: String!) { issueSubscribe(id: $id, userId: $userId) { success } }",
      { id: issueId, userId },
    );
  }
}
