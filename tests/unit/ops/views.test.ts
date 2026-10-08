import { describe, expect, test } from "bun:test";
import { type GraphQLLike, upsertViews } from "../../../src/ops/views";
import { world } from "../../sim/harness";

type ExistingView = {
  id: string;
  name: string;
  slugId: string;
  shared: boolean;
  team: { id: string } | null;
};

function api(
  existing: ExistingView[],
  mutate: (query: string, variables: Record<string, unknown>) => unknown,
): GraphQLLike {
  return {
    query: async <T>(query: string, variables: Record<string, unknown>) => {
      if (query.startsWith("query T")) return { teams: { nodes: [{ id: "team-jrf" }] } } as T;
      if (query.startsWith("query V"))
        return { organization: { urlKey: "jrf" }, customViews: { nodes: existing } } as T;
      return mutate(query, variables) as T;
    },
  };
}

describe("saved views with client-credentials app ownership", () => {
  test("a new shared view defaults to the current actor, without assigning the human workspace owner", async () => {
    const w = await world();
    const inputs: Record<string, unknown>[] = [];
    const g = api([], (query, variables) => {
      expect(query).toContain("customViewCreate");
      const input = variables.input as Record<string, unknown>;
      // Live Linear rejects an explicit human owner with `ownerId must match the current user`.
      if (Object.hasOwn(input, "ownerId")) throw new Error("ownerId must match the current user");
      inputs.push(input);
      return { customViewCreate: { success: true, customView: { slugId: `view-${inputs.length}` } } };
    });
    expect(await upsertViews(w.cfg, g)).toEqual([
      "https://linear.app/jrf/view/view-1",
      "https://linear.app/jrf/view/view-2",
    ]);
    expect(inputs).toHaveLength(2);
    expect(inputs.every((i) => i.shared === true && i.teamId === "team-jrf")).toBe(true);
  });

  test("only the matching team's shared views are updated and ownership is left intact", async () => {
    const w = await world();
    const writes: Record<string, unknown>[] = [];
    const g = api(
      [
        { id: "private", name: "Wingmate", slugId: "p", shared: false, team: { id: "team-jrf" } },
        { id: "other-team", name: "Wingmate", slugId: "o", shared: true, team: { id: "other-team" } },
        { id: "shared", name: "Wingmate", slugId: "s", shared: true, team: { id: "team-jrf" } },
      ],
      (query, variables) => {
        writes.push(variables);
        expect(Object.hasOwn(variables.input as object, "ownerId")).toBe(false);
        return query.includes("customViewUpdate")
          ? { customViewUpdate: { success: true, customView: { slugId: "updated" } } }
          : { customViewCreate: { success: true, customView: { slugId: "created" } } };
      },
    );
    expect(await upsertViews(w.cfg, g)).toEqual([
      "https://linear.app/jrf/view/updated",
      "https://linear.app/jrf/view/created",
    ]);
    expect(writes.map((v) => v.id ?? null)).toEqual(["shared", null]);
  });

  for (const update of [false, true]) {
    test(`a rejected ${update ? "update" : "create"} cannot produce an installed view URL`, async () => {
      const w = await world();
      let mutations = 0;
      const g = api(
        update ? [{ id: "v", name: "Wingmate", slugId: "s", shared: true, team: { id: "team-jrf" } }] : [],
        () => {
          mutations += 1;
          return {
            [update ? "customViewUpdate" : "customViewCreate"]: {
              success: false,
              customView: { slugId: "not-saved" },
            },
          };
        },
      );
      await expect(upsertViews(w.cfg, g)).rejects.toMatchObject({ code: "linear_mutation_failed" });
      expect(mutations).toBe(1);
    });
  }

  test("a successful payload must contain the saved view", async () => {
    const w = await world();
    await expect(
      upsertViews(
        w.cfg,
        api([], () => ({ customViewCreate: { success: true, customView: null } })),
      ),
    ).rejects.toMatchObject({ code: "linear_shape" });
  });
});
