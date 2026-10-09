// tests/unit/machine/guard.test.ts — TES-1: the stop / lost-lock / deadline guard (§6.0, Ruling R16, REL-1) covers every write method of
// every port and no read: the classification below is exhaustive over the port types, so a port method added without one is a tsc error.
import { describe, expect, test } from "bun:test";
import type { Ctx } from "../../../src/machine/context";
import { WRITE_VERBS, guardMethods, guardedCtx } from "../../../src/machine/guard";
import type { GhPort, GitPort, LinearPort, OrcaPort } from "../../../src/ports";

type Kind = "read" | "write";
const LINEAR: Record<keyof LinearPort, Kind> = {
  teamMeta: "read",
  listCandidates: "read",
  listUpdatedSince: "read",
  getIssues: "read",
  issueByIdentifier: "read",
  listComments: "read",
  issueHistory: "read",
  updateIssue: "write",
  createComment: "write",
  updateComment: "write",
  createAttachment: "write",
  createIssue: "write",
  subscribe: "write",
};
const ORCA: Record<keyof OrcaPort, Kind> = {
  cleanupWorkers: "read",
  worktreePs: "read",
  worktreeCurrent: "read",
  terminalList: "read",
  accountList: "read",
  worktreeCreate: "write",
  worktreeShow: "read",
  worktreeSet: "write",
  worktreeRm: "write",
  terminalCreate: "write",
  terminalWait: "read",
  terminalKeys: "write",
  terminalSend: "write",
  terminalClose: "write",
  terminalShowPreview: "read",
  workerList: "read",
  workerStop: "write",
  workerAbandon: "write",
  workerRelease: "write",
  orchestrationSend: "write",
  runList: "read",
  automationsList: "read",
  automationsCreate: "write",
  automationsEdit: "write",
};
const GIT: Record<keyof GitPort, Kind> = {
  cleanupStatus: "read",
  revParse: "read",
  hasTrackedChanges: "read",
  changedPaths: "read",
  addedLines: "read",
  commitsAhead: "read",
  historyChanges: "read",
  push: "write",
  lsRemoteSha: "read",
  fetchCommit: "write", // C30: it writes the repository's object store
  isAncestor: "read",
  replaceRefs: "read",
  refsNamedAfter: "read",
  useReplaceRefs: "read",
  disableReplaceRefs: "write", // R30: it writes the repository's config
  credentialConfig: "read",
};
const GH: Record<keyof GhPort, Kind> = { prCreate: "write", prView: "read", hasOpenPr: "read" };
const PORTS = { linear: LINEAR, orca: ORCA, git: GIT, gh: GH } as const;
const of = (m: Record<string, Kind>, kind: Kind) =>
  Object.entries(m)
    .filter(([, k]) => k === kind)
    .map(([n]) => n)
    .sort();
/** A port whose every method only records that it was reached. */
function recorder(methods: Record<string, Kind>, reached: string[]): Record<string, () => Promise<null>> {
  return Object.fromEntries(
    Object.keys(methods).map((m) => [
      m,
      async () => {
        reached.push(m);
        return null;
      },
    ]),
  );
}

describe("TES-1: the guard's write verbs", () => {
  test("are exactly each port's write methods (pinned against the port types)", () => {
    for (const [port, methods] of Object.entries(PORTS))
      expect({ port, verbs: [...WRITE_VERBS[port as keyof typeof PORTS]].map(String).sort() }).toEqual({
        port,
        verbs: of(methods, "write"),
      });
  });

  test("each write runs the check first and never reaches the port when it refuses; each read passes through unchecked", async () => {
    for (const [port, methods] of Object.entries(PORTS)) {
      const reached: string[] = [];
      const checked: string[] = [];
      const guarded = guardMethods(
        recorder(methods, reached),
        WRITE_VERBS[port as keyof typeof PORTS],
        async (verb) => {
          checked.push(verb);
          throw new Error(`refused ${verb}`);
        },
      );
      for (const [m, kind] of Object.entries(methods)) {
        const call = guarded[m]?.() ?? Promise.reject(new Error(`no method ${m}`));
        if (kind === "write") await expect(call).rejects.toThrow(`refused ${m}`);
        else await call;
      }
      expect({ port, checked: checked.sort(), reached: reached.sort() }).toEqual({
        port,
        checked: of(methods, "write"),
        reached: of(methods, "read"),
      });
    }
  });

  test("guardedCtx puts the check in front of every port's writes and the process sweep", async () => {
    const reached: string[] = [];
    const checked: string[] = [];
    const ports = Object.fromEntries(Object.entries(PORTS).map(([p, m]) => [p, recorder(m, reached)]));
    const base = {
      ...ports,
      now: () => "2026-10-07T00:00:00.000Z",
      kitDirFor: (id: string) => `/kit/${id}`,
      publishImpl: async () => ({ publish: async () => true }),
      sweep: async () => {
        reached.push("sweep");
        return { killed: [] };
      },
    } as unknown as Ctx;
    const ctx = guardedCtx(base, async (verb) => {
      checked.push(verb);
      throw new Error("stopped");
    });
    const call = (port: keyof typeof PORTS, m: string) =>
      (ctx[port] as unknown as Record<string, () => Promise<unknown>>)[m]?.();
    for (const [port, methods] of Object.entries(PORTS))
      for (const m of of(methods, "write"))
        await expect(call(port as keyof typeof PORTS, m)).rejects.toThrow("stopped");
    await expect(ctx.sweep(["/wt"])).rejects.toThrow("stopped");
    expect(reached).toEqual([]);
    expect(checked).toContain("push");
    expect(checked).toContain("updateIssue");
    expect(checked).toContain("sweep");
  });
});
