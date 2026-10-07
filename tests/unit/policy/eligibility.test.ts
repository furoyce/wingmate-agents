import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ConfigSchema, withDefaults } from "../../../src/config/schema";
import { type EligibilityCtx, evaluateCandidate } from "../../../src/policy/eligibility";
import type { FleetSnapshot, LinearIssue } from "../../../src/ports";
import { newRecord } from "../../../src/state/records";

const cfg = withDefaults(
  ConfigSchema.parse(JSON.parse(readFileSync("tests/fixtures/config.min.json", "utf8"))),
);
const OWNER = "71aef180-1742-4a76-8d49-51f14e8ada1e";
const AGENT_GROUP = "9703cfa1";
const LIFE_GROUP = "ce8ee8fb";
const label = (name: string, group: "agent" | "life") => ({
  id: `id-${name}`,
  name,
  parentId: group === "agent" ? AGENT_GROUP : LIFE_GROUP,
  parentName: group === "agent" ? "Agent" : "Lifecycle",
});
const base = (over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: "i1",
  identifier: "JRF-500",
  title: "t",
  description: null,
  url: "",
  createdAt: "2026-10-06T09:00:00.000Z",
  updatedAt: "2026-10-06T09:00:00.000Z",
  archivedAt: null,
  trashed: false,
  priority: 2,
  branchName: "b",
  state: { id: "s", name: "Todo", type: "unstarted" },
  projectId: "0ca67822-6416-447b-b7b2-08ab2a7346dd",
  teamId: "t",
  assigneeId: OWNER,
  delegateId: null,
  labels: [label("agent-ready", "agent")],
  subscriberIds: [],
  parent: null,
  children: [],
  prerequisites: [],
  attachments: [],
  ...over,
});
const fleet: FleetSnapshot = { worktrees: [], truncated: false, omittedHostIds: [] };
const ctx = (over: Partial<EligibilityCtx> = {}): EligibilityCtx => ({
  cfg,
  agentLabelIds: new Map([
    ["agent-ready", "id-agent-ready"],
    ["claude", "id-claude"],
    ["codex", "id-codex"],
    ["human", "id-human"],
  ]),
  lifecycleGroupId: LIFE_GROUP,
  agentGroupId: AGENT_GROUP,
  history: [
    {
      id: "h",
      createdAt: "2026-10-06T09:00:00.000Z",
      actorId: OWNER,
      botActorId: null,
      botActorType: null,
      addedLabelIds: ["id-agent-ready"],
      removedLabelIds: [],
      fromStateId: null,
      toStateId: null,
    },
  ],
  fleet,
  records: [],
  pausedScopes: [],
  liveCoordinator: () => false,
  ...over,
});
const record = (stage: "working" | "blocked") => ({
  ...newRecord({
    identifier: "JRF-500",
    linearId: "i1",
    project: "bouncr",
    repo: "api",
    provider: "claude",
    autonomy: "ask-first",
    now: "2026-10-06T09:00:00.000Z",
  }),
  stage,
});
const cases: [string, Partial<LinearIssue>, Partial<EligibilityCtx>, string][] = [
  ["todo + agent-ready is eligible", {}, {}, "eligible"],
  ["backlog is not_todo", { state: { id: "s", name: "Backlog", type: "backlog" } }, {}, "not_todo"],
  ["archived", { archivedAt: "2026-10-01T00:00:00.000Z" }, {}, "archived"],
  ["trashed", { trashed: true }, {}, "archived"],
  ["unknown project", { projectId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }, {}, "not_todo"],
  ["human label", { labels: [label("human", "agent")] }, {}, "human"],
  ["unsupported provider label", { labels: [label("gemini", "agent")] }, {}, "unsupported_provider"],
  [
    "two agent labels",
    { labels: [label("claude", "agent"), label("codex", "agent")] },
    {},
    "conflicting_agent_labels",
  ],
  [
    "veto lifecycle label",
    { labels: [label("agent-ready", "agent"), label("Needs-Human", "life")] },
    {},
    "veto_label",
  ],
  [
    "Ready label is allowed",
    { labels: [label("agent-ready", "agent"), label("Ready", "life")] },
    {},
    "eligible",
  ],
  [
    "open child",
    { children: [{ id: "c", identifier: "JRF-501", stateType: "started" }] },
    {},
    "has_open_children",
  ],
  [
    "completed child is fine",
    { children: [{ id: "c", identifier: "JRF-501", stateType: "completed" }] },
    {},
    "eligible",
  ],
  [
    "open prerequisite",
    { prerequisites: [{ id: "p", identifier: "JRF-499", stateType: "started" }] },
    {},
    "prerequisite_open",
  ],
  [
    "label added by a non-approver",
    {},
    {
      history: [
        {
          id: "h",
          createdAt: "2026-10-06T09:00:00.000Z",
          actorId: "someone-else",
          botActorId: null,
          botActorType: null,
          addedLabelIds: ["id-agent-ready"],
          removedLabelIds: [],
          fromStateId: null,
          toStateId: null,
        },
      ],
    },
    "label_by_unlisted_actor",
  ],
  ["paused project", {}, { pausedScopes: ["bouncr"] }, "paused"],
  ["paused globally", {}, { pausedScopes: ["global"] }, "paused"],
  [
    "live owner in fleet",
    {},
    {
      fleet: {
        worktrees: [
          {
            worktreeId: "w",
            repoId: "r",
            path: "/p",
            branch: "b",
            displayName: "d",
            linkedLinearIssue: "JRF-500",
            status: "working",
            liveTerminalCount: 1,
            lastOutputAt: null,
            childWorktreeIds: [],
            agents: [
              {
                paneKey: "a:b",
                state: "working",
                agentType: "claude",
                stateStartedAt: null,
                updatedAt: null,
              },
            ],
          },
        ],
        truncated: false,
        omittedHostIds: [],
      },
    },
    "live_owner",
  ],
  [
    "non-terminal record with live coordinator",
    {},
    { records: [record("working")], liveCoordinator: () => true },
    "live_owner",
  ],
  [
    "non-terminal record without a live coordinator still vetoes",
    {},
    { records: [record("working")] },
    "live_owner",
  ],
  ["terminal record never vetoes", {}, { records: [record("blocked")] }, "eligible"],
];
describe("evaluateCandidate", () => {
  for (const [name, issueOver, ctxOver, expected] of cases)
    test(name, () => {
      const v = evaluateCandidate(base(issueOver), ctx(ctxOver));
      expect(v.status === "eligible" ? "eligible" : v.reason).toBe(expected);
    });
  test("explicit provider label resolves the provider", () => {
    const v = evaluateCandidate(
      base({ labels: [label("codex", "agent")] }),
      ctx({
        history: [
          {
            id: "h",
            createdAt: "x",
            actorId: OWNER,
            botActorId: null,
            botActorType: null,
            addedLabelIds: ["id-codex"],
            removedLabelIds: [],
            fromStateId: null,
            toStateId: null,
          },
        ],
      }),
    );
    expect(v).toMatchObject({ status: "eligible", provider: "codex" });
  });
  test("agent-ready resolves to the agent-ready pseudo-provider with the project attached", () => {
    const v = evaluateCandidate(base(), ctx());
    expect(v).toMatchObject({ status: "eligible", provider: "agent-ready", project: { key: "bouncr" } });
  });
  test("without history (pre-check) the authorship rule is skipped", () => {
    expect(evaluateCandidate(base(), ctx({ history: null })).status).toBe("eligible");
  });
});
