// tests/fakes/fakeLinear.ts — in-memory LinearPort with programmable writes, history and failure injection. Reads return copies, as
// a real API does, so a tick's snapshot never changes under it; every issue write is logged with the state before and after (I5).
import type {
  LinearComment,
  LinearHistoryEntry,
  LinearIssue,
  LinearLabel,
  LinearPort,
  LinearTeamMeta,
} from "../../src/ports";
import { WingmateError } from "../../src/shared/errors";

const AGENT_LABELS: LinearLabel[] = ["agent-ready", "claude", "codex", "human", "gemini"].map((n) => ({
  id: `lb-${n}`,
  name: n,
  parentId: "grp-agent",
  parentName: "Agent",
}));
const LIFECYCLE_LABELS: LinearLabel[] = ["Ready", "In-Agent", "Needs-Human", "Review-Ready", "Blocked"].map(
  (n) => ({
    id: `lb-${n}`,
    name: n,
    parentId: "grp-life",
    parentName: "Lifecycle",
  }),
);
const OTHER_LABELS: LinearLabel[] = [
  { id: "lb-allow-deps", name: "allow-deps", parentId: null, parentName: null },
];

export interface IssueWrite {
  issueId: string;
  before: { stateId: string; labelIds: string[] };
  after: { stateId: string; labelIds: string[] };
}

export class FakeLinear implements LinearPort {
  issues = new Map<string, LinearIssue>();
  comments: LinearComment[] = [];
  history = new Map<string, LinearHistoryEntry[]>();
  writes: { kind: string; args: unknown }[] = [];
  /** Every successful `updateIssue`, with the issue's state and labels before and after (invariant I5). */
  issueWrites: IssueWrite[] = [];
  /** When set to a write kind, the next write of that kind throws once (replay tests). */
  failNext: string | null = null;
  /** Called at the start of every port method (reads and writes): tests inject an owner edit "between read and write". */
  onCall: ((method: string) => void) | null = null;
  meta: LinearTeamMeta = {
    states: [
      { id: "st-backlog", name: "Backlog", type: "backlog" },
      { id: "st-todo", name: "Todo", type: "unstarted" },
      { id: "st-prog", name: "In Progress", type: "started" },
      { id: "st-review", name: "In Review", type: "started" },
      { id: "st-done", name: "Done", type: "completed" },
      { id: "st-cancel", name: "Canceled", type: "canceled" },
    ],
    labels: [...AGENT_LABELS, ...LIFECYCLE_LABELS, ...OTHER_LABELS],
  };
  now = () => new Date().toISOString();

  private call(method: string) {
    this.onCall?.(method);
  }
  private bump(kind: string, args: unknown) {
    if (this.failNext === kind) {
      this.failNext = null;
      throw new WingmateError("linear_unreachable", `fake linear failure: ${kind}`); // as LinearClient reports transport failures
    }
    this.writes.push({ kind, args });
  }

  add(i: LinearIssue) {
    this.issues.set(i.id, i);
  }
  async teamMeta() {
    return structuredClone(this.meta);
  }
  async listCandidates(projectIds: string[], labelNames: string[]) {
    this.call("listCandidates");
    return structuredClone(
      [...this.issues.values()].filter(
        (i) =>
          i.projectId &&
          projectIds.includes(i.projectId) &&
          i.state.type === "unstarted" &&
          i.labels.some((l) => labelNames.includes(l.name)),
      ),
    );
  }
  async listUpdatedSince(projectIds: string[], since: string) {
    this.call("listUpdatedSince");
    return structuredClone(
      [...this.issues.values()].filter(
        (i) => i.projectId && projectIds.includes(i.projectId) && i.updatedAt > since,
      ),
    );
  }
  async getIssues(ids: string[]) {
    this.call("getIssues");
    return structuredClone(
      ids.flatMap((id) => {
        const i = this.issues.get(id);
        return i ? [i] : [];
      }),
    );
  }
  async issueByIdentifier(identifier: string) {
    this.call("issueByIdentifier");
    const i = [...this.issues.values()].find((x) => x.identifier === identifier);
    return i ? structuredClone(i) : null;
  }
  async listComments(issueIds: string[], since: string) {
    this.call("listComments");
    return structuredClone(this.comments.filter((c) => issueIds.includes(c.issueId) && c.createdAt > since));
  }
  async issueHistory(issueId: string, since: string) {
    this.call("issueHistory");
    return structuredClone((this.history.get(issueId) ?? []).filter((h) => h.createdAt > since));
  }
  async updateIssue(
    issueId: string,
    input: { stateId?: string; labelIds?: string[]; subscriberIds?: string[] },
  ) {
    this.call("updateIssue");
    this.bump("issueUpdate", { issueId, input });
    const i = this.issues.get(issueId);
    if (!i) return;
    const before = { stateId: i.state.id, labelIds: i.labels.map((l) => l.id) };
    if (input.stateId) {
      const s = this.meta.states.find((x) => x.id === input.stateId);
      if (s) i.state = { ...s };
    }
    if (input.labelIds) {
      i.labels = input.labelIds.flatMap((id) => {
        const l = this.meta.labels.find((x) => x.id === id);
        return l ? [{ ...l }] : [];
      });
    }
    if (input.subscriberIds) i.subscriberIds = input.subscriberIds;
    i.updatedAt = new Date(Date.parse(i.updatedAt) + 1000).toISOString();
    this.issueWrites.push({
      issueId,
      before,
      after: { stateId: i.state.id, labelIds: i.labels.map((l) => l.id) },
    });
  }
  async createComment(issueId: string, body: string, opts: { id: string; parentId?: string }) {
    this.call("createComment");
    this.bump("commentCreate", { issueId, opts });
    this.comments.push({
      id: opts.id,
      issueId,
      body,
      createdAt: this.now(),
      parentId: opts.parentId ?? null,
      userId: null,
      botActorId: "app-wingmate",
      externalUserId: null,
    });
    return { id: opts.id };
  }
  async updateComment(id: string, body: string) {
    this.call("updateComment");
    this.bump("commentUpdate", { id });
    const c = this.comments.find((x) => x.id === id);
    if (c) c.body = body;
  }
  async createAttachment(issueId: string, url: string, title: string) {
    this.call("createAttachment");
    this.bump("attachment", { issueId, url, title });
    this.issues.get(issueId)?.attachments.push({ id: `att-${url}`, url, title });
  }
  async createIssue(input: {
    id: string;
    teamId: string;
    projectId: string | null;
    parentId: string;
    title: string;
    description: string;
    stateId: string;
  }) {
    this.call("createIssue");
    this.bump("issueCreate", input);
    return { id: input.id, identifier: `JRF-${900 + this.writes.length}` };
  }
  async subscribe(issueId: string, userId: string) {
    this.call("subscribe");
    this.bump("subscribe", { issueId, userId });
    const i = this.issues.get(issueId);
    if (i && !i.subscriberIds.includes(userId)) i.subscriberIds.push(userId);
  }

  // --- test helpers: simulate the owner acting in Linear ---
  humanComment(
    issueId: string,
    body: string,
    userId: string,
    createdAt: string,
    parentId: string | null = null,
  ): LinearComment {
    const c: LinearComment = {
      id: `c-${this.comments.length + 1}`,
      issueId,
      body,
      createdAt,
      parentId,
      userId,
      botActorId: null,
      externalUserId: null,
    };
    this.comments.push(c);
    return c;
  }
  setState(issueId: string, name: string, actorId: string, at: string) {
    const i = this.issues.get(issueId);
    const s = this.meta.states.find((x) => x.name === name);
    if (!i || !s) throw new Error(`setState: unknown issue ${issueId} or state ${name}`);
    const from = i.state.id;
    i.state = { ...s };
    i.updatedAt = at;
    const h = this.history.get(issueId) ?? [];
    h.push({
      id: `h${h.length}`,
      createdAt: at,
      actorId,
      botActorId: null,
      botActorType: null,
      addedLabelIds: [],
      removedLabelIds: [],
      fromStateId: from,
      toStateId: s.id,
    });
    this.history.set(issueId, h);
  }
  setLabels(issueId: string, names: string[], actorId: string, at: string) {
    const i = this.issues.get(issueId);
    if (!i) throw new Error(`setLabels: unknown issue ${issueId}`);
    const before = new Set(i.labels.map((l) => l.id));
    i.labels = names.map((n) => {
      const l = this.meta.labels.find((x) => x.name === n);
      if (!l) throw new Error(`setLabels: unknown label ${n}`);
      return { ...l };
    });
    const after = new Set(i.labels.map((l) => l.id));
    i.updatedAt = at;
    const h = this.history.get(issueId) ?? [];
    h.push({
      id: `h${h.length}`,
      createdAt: at,
      actorId,
      botActorId: null,
      botActorType: null,
      addedLabelIds: [...after].filter((x) => !before.has(x)),
      removedLabelIds: [...before].filter((x) => !after.has(x)),
      fromStateId: null,
      toStateId: null,
    });
    this.history.set(issueId, h);
  }
}
