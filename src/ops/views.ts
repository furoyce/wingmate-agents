// src/ops/views.ts — §11.5 the two shared saved views, created or updated idempotently by `install` as the Wingmate app (team
// `workspace.team`, owned by the app). Linear requires a new view's owner to match its creator; a client-credentials token therefore
// cannot create one owned by `workspace.owner`. Linear's API takes the filter but not the board/list display, so `install` prints the
// manual display steps with the URLs. Not part of LinearPort: install-only, over the app's GraphQL client.
import { z } from "zod";
import type { Config } from "../config/schema";
import { WingmateError } from "../shared/errors";

export interface ViewDef {
  name: string;
  description: string;
  filterData: Record<string, unknown>;
  /** Informational: what the owner sets by hand (the API does not expose custom-view display settings). */
  display: { layout: "board" | "list"; grouping: string; ordering: string };
}
export interface GraphQLLike {
  query<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

/** The Lifecycle labels Wingmate sets (§5.2); `Ready` is the owner's and is no column of the board (§11.5). */
const wingmateLabels = (cfg: Config) => cfg.labels.lifecycle.filter((n) => n !== "Ready");

export function viewDefinitions(cfg: Config): ViewDef[] {
  const projectIds = Object.values(cfg.projects).map((p) => p.linearProject);
  const pilots = { project: { id: { in: projectIds } } };
  const open = { state: { type: { nin: ["completed", "canceled"] } } };
  const needsYou = ["Needs-Human", "Blocked", "Review-Ready"].filter((n) => cfg.labels.lifecycle.includes(n));
  return [
    {
      name: "Wingmate",
      description: "Issues an agent is working on, waiting on you, ready for review, or blocked.",
      filterData: { and: [pilots, { labels: { name: { in: wingmateLabels(cfg) } } }, open] },
      display: {
        layout: "board",
        grouping: `label group ${cfg.labels.lifecycleGroup}`,
        ordering: "priority",
      },
    },
    {
      name: "Wingmate · Needs you",
      description: "Agent work that cannot continue without you.",
      filterData: { and: [pilots, { labels: { name: { in: needsYou } } }, open] },
      display: { layout: "list", grouping: "label", ordering: "last updated" },
    },
  ];
}

/** The manual steps `install` prints with the URLs, or alone when the views cannot be written as the app. */
export function viewRecipe(cfg: Config): string[] {
  const [all, needsYou] = viewDefinitions(cfg);
  return [
    `In Linear, team ${cfg.workspace.team}: create two shared views (or open the URLs above).`,
    `1. "${all?.name}": project in the pilot projects, label in ${wingmateLabels(cfg).join("/")}, status not Done/Canceled; layout board, grouped by the ${cfg.labels.lifecycleGroup} label group, ordered by priority.`,
    `2. "${needsYou?.name}": the same projects, label in Needs-Human/Blocked/Review-Ready, status not Done/Canceled; layout list, grouped by label, ordered by last updated.`,
    '3. Favorite both views and subscribe to "Wingmate · Needs you" (issue added to view); enable Slack/push for comments and mentions in Settings → Notifications (§7.5).',
  ];
}

const Shape = {
  team: z.object({ teams: z.object({ nodes: z.array(z.object({ id: z.string().min(1) })) }) }),
  views: z.object({
    organization: z.object({ urlKey: z.string().min(1) }),
    customViews: z.object({
      nodes: z.array(
        z.object({
          id: z.string().min(1),
          name: z.string(),
          slugId: z.string().min(1),
          shared: z.boolean().nullish(),
          team: z.object({ id: z.string() }).nullish(),
        }),
      ),
    }),
  }),
  create: z.object({
    customViewCreate: z.object({
      success: z.boolean(),
      customView: z.object({ slugId: z.string().min(1) }).nullish(),
    }),
  }),
  update: z.object({
    customViewUpdate: z.object({
      success: z.boolean(),
      customView: z.object({ slugId: z.string().min(1) }).nullish(),
    }),
  }),
};
function shaped<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data as z.infer<S>;
  const i = r.error.issues[0];
  throw new WingmateError(
    "linear_shape",
    `${what}: ${i?.path.join(".") || "(root)"} ${i?.message ?? "invalid"}`,
  );
}

function savedSlug(
  payload: { success: boolean; customView?: { slugId: string } | null | undefined },
  mutation: string,
): string {
  if (!payload.success)
    throw new WingmateError("linear_mutation_failed", `${mutation} returned success: false`);
  if (!payload.customView)
    throw new WingmateError("linear_shape", `${mutation}: successful payload has no customView`);
  return payload.customView.slugId;
}

/** Creates or updates both shared views of team `workspace.team`; returns their URLs in `viewDefinitions` order. */
export async function upsertViews(cfg: Config, g: GraphQLLike): Promise<string[]> {
  const team = shaped(
    Shape.team,
    await g.query("query T($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }", {
      key: cfg.workspace.team,
    }),
    "teams",
  );
  const teamId = team.teams.nodes[0]?.id;
  if (!teamId) throw new WingmateError("linear_team_missing", `team ${cfg.workspace.team} not found`);
  const existing = shaped(
    Shape.views,
    await g.query(
      "query V { organization { urlKey } customViews(first: 250) { nodes { id name slugId shared team { id } } } }",
      {},
    ),
    "customViews",
  );
  const urls: string[] = [];
  for (const v of viewDefinitions(cfg)) {
    const found = existing.customViews.nodes.find(
      (n) => n.name === v.name && n.team?.id === teamId && n.shared === true,
    );
    const input = { name: v.name, description: v.description, filterData: v.filterData, shared: true };
    const slugId = found
      ? savedSlug(
          shaped(
            Shape.update,
            await g.query(
              "mutation U($id: String!, $input: CustomViewUpdateInput!) { customViewUpdate(id: $id, input: $input) { success customView { slugId } } }",
              { id: found.id, input },
            ),
            "customViewUpdate",
          ).customViewUpdate,
          "customViewUpdate",
        )
      : savedSlug(
          shaped(
            Shape.create,
            await g.query(
              "mutation C($input: CustomViewCreateInput!) { customViewCreate(input: $input) { success customView { slugId } } }",
              { input: { ...input, teamId } },
            ),
            "customViewCreate",
          ).customViewCreate,
          "customViewCreate",
        );
    urls.push(`https://linear.app/${existing.organization.urlKey}/view/${slugId}`);
  }
  return urls;
}
