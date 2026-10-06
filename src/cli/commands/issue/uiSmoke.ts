// src/cli/commands/issue/uiSmoke.ts — `wingmate issue <id> ui-smoke --recipe <file>` (§8.1): the only path by which an agent
// drives Orca's embedded browser. Slice-1 minimum: an isolated profile and tab, the recipe's goto/click/expectText steps at each
// requested viewport, a screenshot after every step under .wingmate/evidence/ui/<run>/, then the tab and profile are removed.
//
// Verbs pinned from `orca agent-context --json` (Orca 1.4.220, read 2026-10-06). Every run re-reads agent-context once and
// refuses `ui_smoke_unavailable`, naming the verb or flag, when this Orca build lacks one the recipe needs:
//   browser identity get                                → result.identity.appliedMode must be `clean` (§8.2 stage 5)
//   tab profile create --label <l> --scope isolated     → profile id;   tab profile delete --profile <id>
//   tab create --url <u> --profile <id>                 → browserPageId when present, then `--page <id>` on every later verb
//   viewport --width <w> --height <h>   goto --url <u>   screenshot --format png   tab close
//   find --locator first --value <css> --action click   (`click` itself takes only snapshot refs; `first` is agent-browser's
//                                                        semantic locator for a CSS selector — confirm on the first live run)
//   wait --text <t> --timeout <ms>
import { copyFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { worktreeFile } from "../../../kit/local";
import { OrcaError, orca } from "../../../orca/cli";
import { run } from "../../../shared/exec";
import { newUlid } from "../../../shared/ids";
import { readText, writeAtomic } from "../../../state/fs";
import type { OrcaExec, Out, Refuse } from "../issue";

/** The embedded browser runs outside the agent sandbox, so recipes may only reach the local dev server (no file:, no egress). */
const LOOPBACK = /^(localhost|[a-z0-9-]+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
const LocalUrl = z
  .string()
  .url()
  .refine((u) => {
    const x = new URL(u);
    return (x.protocol === "http:" || x.protocol === "https:") && LOOPBACK.test(x.hostname);
  }, "must be an http(s) URL on localhost, 127.0.0.1 or [::1]");
const StepZ = z.union([
  z.object({ goto: LocalUrl }).strict(),
  z.object({ click: z.string().min(1) }).strict(),
  z.object({ expectText: z.string().min(1) }).strict(),
]);
export const RecipeSchema = z
  .object({
    url: LocalUrl,
    viewports: z
      .array(z.tuple([z.number().int().positive(), z.number().int().positive()]))
      .max(4)
      .default([]),
    steps: z.array(StepZ).max(50).default([]),
  })
  .strict();
export type Recipe = z.infer<typeof RecipeSchema>;
export type Step = Recipe["steps"][number];
const RECIPE_HINT =
  'recipe = { "url": "http://localhost:<port>/", "viewports": [[1280,800],[390,844]], "steps": [{"goto"}|{"click": "<css>"}|{"expectText"}] }';

const AgentContextZ = z.object({
  commands: z.array(z.object({ command: z.string(), flags: z.array(z.string()) })),
});
const IdentityZ = z.object({ identity: z.object({ appliedMode: z.string() }) });
type Verb = { command: string; flags: string[] };

/** The pinned verbs (and flags) this recipe needs. */
export function requiredVerbs(recipe: Recipe): Verb[] {
  const v: Verb[] = [
    { command: "browser identity get", flags: [] },
    { command: "tab profile create", flags: ["label", "scope"] },
    { command: "tab profile delete", flags: ["profile"] },
    { command: "tab create", flags: ["url", "profile"] },
    { command: "screenshot", flags: ["format"] },
    { command: "tab close", flags: [] },
  ];
  if (recipe.viewports.length) v.push({ command: "viewport", flags: ["width", "height"] });
  if (recipe.viewports.length > 1 || recipe.steps.some((s) => "goto" in s))
    v.push({ command: "goto", flags: ["url"] });
  if (recipe.steps.some((s) => "click" in s))
    v.push({ command: "find", flags: ["locator", "value", "action"] });
  if (recipe.steps.some((s) => "expectText" in s)) v.push({ command: "wait", flags: ["text", "timeout"] });
  return v;
}

/** The first needed verb (or `verb --flag`) missing from `orca agent-context --json`, or null when all are present. */
export function missingVerb(context: unknown, verbs: Verb[]): string | null {
  const parsed = AgentContextZ.safeParse(context);
  if (!parsed.success) return "agent-context (unexpected schema)";
  const byName = new Map(parsed.data.commands.map((c) => [c.command, new Set(c.flags)]));
  for (const v of verbs) {
    const flags = byName.get(v.command);
    if (!flags) return v.command;
    const lack = v.flags.find((f) => !flags.has(f));
    if (lack) return `${v.command} --${lack}`;
  }
  return null;
}

const ORCA_BIN = process.env.WINGMATE_ORCA_BIN ?? "/usr/local/bin/orca"; // same resolution as src/orca/cli.ts
/** `agent-context --json` prints the schema itself rather than an `{ ok, result }` envelope, so it bypasses `orca()`. */
export async function readAgentContext(): Promise<unknown> {
  const r = await run([ORCA_BIN, "agent-context", "--json"], { timeoutMs: 30_000 });
  if (r.code !== 0)
    throw new OrcaError("orca_unreachable", `exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new OrcaError("orca_shape", "printed no JSON");
  }
}

export const profileArgv = (id: string) => [
  "tab",
  "profile",
  "create",
  "--label",
  `wingmate-${id}`,
  "--scope",
  "isolated",
];
export const tabCreateArgv = (url: string, profileId: string) => [
  "tab",
  "create",
  "--url",
  url,
  "--profile",
  profileId,
];
export const viewportArgv = (w: number, h: number) => [
  "viewport",
  "--width",
  String(w),
  "--height",
  String(h),
];
/** The argv for one step (exported so tests pin the vocabulary without a browser). */
export function stepArgv(step: Step): { name: string; argv: string[] } {
  if ("goto" in step) return { name: "goto", argv: ["goto", "--url", step.goto] };
  if ("click" in step)
    return {
      name: "click",
      argv: ["find", "--locator", "first", "--value", step.click, "--action", "click"],
    };
  return { name: "expectText", argv: ["wait", "--text", step.expectText, "--timeout", "10000"] };
}
const onPage = (argv: string[], page: string | null) => (page ? [...argv, "--page", page] : argv);

type R = Record<string, unknown>;
const rec = (v: unknown): R => (v && typeof v === "object" && !Array.isArray(v) ? (v as R) : {});
const str = (...xs: unknown[]) => xs.find((x): x is string => typeof x === "string" && x.length > 0) ?? null;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Saves one screenshot; a failed or unrecognized capture leaves a note file instead (and no `.png`). */
async function saveShot(exec: OrcaExec, page: string | null, file: string): Promise<string> {
  try {
    const r = rec(await exec(onPage(["screenshot", "--format", "png"], page)));
    const nested = rec(r.screenshot);
    const path = str(r.path, nested.path);
    const b64 = str(r.data, r.base64, r.image, nested.data, nested.base64);
    if (path) await copyFile(path, file);
    else if (b64) await Bun.write(file, Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), "base64"));
    else {
      await writeAtomic(`${file}.json`, JSON.stringify({ unrecognizedKeys: Object.keys(r) }, null, 2));
      return `${file}.json`;
    }
    return file;
  } catch (e) {
    await writeAtomic(`${file}.error.txt`, msg(e).slice(0, 2000));
    return `${file}.error.txt`;
  }
}

type Failure = { viewport: string; step: number; name: string; error: string };

/** Drives the recipe; setup verbs that fail throw, step failures are collected. */
async function drive(exec: OrcaExec, recipe: Recipe, page: string | null, dir: string, shots: string[]) {
  const failures: Failure[] = [];
  const viewports: ([number, number] | null)[] = recipe.viewports.length ? recipe.viewports : [null];
  for (const [vi, vp] of viewports.entries()) {
    const label = vp ? `${vp[0]}x${vp[1]}` : "default";
    if (vp) await exec(onPage(viewportArgv(vp[0], vp[1]), page));
    if (vi > 0) await exec(onPage(["goto", "--url", recipe.url], page));
    shots.push(await saveShot(exec, page, join(dir, `${label}-00-open.png`)));
    for (const [n, step] of recipe.steps.entries()) {
      const { name, argv } = stepArgv(step);
      try {
        await exec(onPage(argv, page), { timeoutMs: 30_000 });
      } catch (e) {
        failures.push({ viewport: label, step: n + 1, name, error: msg(e).slice(0, 300) });
      }
      shots.push(
        await saveShot(exec, page, join(dir, `${label}-${String(n + 1).padStart(2, "0")}-${name}.png`)),
      );
    }
  }
  return failures;
}

async function readRecipe(cwd: string, recipeFile: string): Promise<Recipe | string> {
  const rf = await worktreeFile(cwd, recipeFile);
  if (!rf.ok) return rf.error;
  try {
    return RecipeSchema.parse(JSON.parse((await readText(rf.abs)) ?? ""));
  } catch (e) {
    if (e instanceof z.ZodError)
      return `${rf.rel}: ${e.issues[0]?.path.join(".") ?? ""} ${e.issues[0]?.message ?? ""}`;
    return `${rf.rel}: ${msg(e)}`;
  }
}

export async function uiSmoke(
  cwd: string,
  id: string,
  recipeFile: string,
  out: Out,
  refuse: Refuse,
  exec: OrcaExec = orca,
  agentContext: () => Promise<unknown> = readAgentContext,
): Promise<number> {
  const recipe = await readRecipe(cwd, recipeFile);
  if (typeof recipe === "string") return refuse("ui_smoke_recipe_invalid", recipe, RECIPE_HINT);
  const next = "update Orca, or ask the owner; do not drive orca browser verbs directly";
  let context: unknown;
  try {
    context = await agentContext();
  } catch (e) {
    return refuse("ui_smoke_unavailable", `orca agent-context: ${msg(e)}`, next);
  }
  const missing = missingVerb(context, requiredVerbs(recipe));
  if (missing)
    return refuse("ui_smoke_unavailable", `orca ${missing} is not available in this Orca build`, next);
  const identity = IdentityZ.safeParse(await exec(["browser", "identity", "get"]));
  if (!identity.success)
    return refuse("ui_smoke_unavailable", "orca browser identity get: unexpected shape", next);
  if (identity.data.identity.appliedMode !== "clean")
    return refuse(
      "ui_smoke_unavailable",
      `browser identity is ${identity.data.identity.appliedMode}; UI checks run only on a clean identity`,
      "ask the owner (orca browser identity set --mode clean is an owner action)",
    );
  const runDir = join(".wingmate", "evidence", "ui", newUlid());
  const dir = join(cwd, runDir);
  await mkdir(dir, { recursive: true });
  const p = rec(await exec(profileArgv(id)));
  const profileId = str(rec(p.profile).id, p.id, p.profileId);
  if (!profileId) return refuse("ui_smoke_failed", "tab profile create returned no profile id");
  const shots: string[] = [];
  const cleanup: string[] = [];
  let page: string | null = null;
  let tabOpen = false; // never `tab close` a tab this run did not open (it would close the active one)
  let failures: Failure[];
  try {
    const t = rec(await exec(tabCreateArgv(recipe.url, profileId)));
    tabOpen = true;
    page = str(t.browserPageId, rec(t.tab).browserPageId, rec(t.page).browserPageId);
    failures = await drive(exec, recipe, page, dir, shots);
  } catch (e) {
    return refuse("ui_smoke_failed", `browser setup failed: ${msg(e).slice(0, 300)}`, next);
  } finally {
    if (tabOpen)
      await exec(onPage(["tab", "close"], page)).catch((e: unknown) => cleanup.push(`tab close: ${msg(e)}`));
    await exec(["tab", "profile", "delete", "--profile", profileId]).catch((e: unknown) =>
      cleanup.push(`tab profile delete: ${msg(e)}`),
    );
  }
  const screenshots = shots.map((s) => relative(cwd, s));
  const index = {
    recipe: recipeFile,
    url: recipe.url,
    viewports: recipe.viewports,
    steps: recipe.steps.map((s, n) => ({ n: n + 1, ...stepArgv(s) })),
    screenshots,
    failures,
    cleanup,
    at: new Date().toISOString(),
  };
  await writeAtomic(join(dir, "index.json"), JSON.stringify(index, null, 2));
  const captured = screenshots.every((s) => s.endsWith(".png"));
  out({
    ok: true,
    evidenceDir: runDir,
    index: join(runDir, "index.json"),
    screenshots,
    failures,
    verdictHint: failures.length || !captured ? "FAIL" : "PASS",
  });
  return 0;
}
