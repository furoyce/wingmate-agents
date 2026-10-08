import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  RuntimeSchema,
  assertRuntime,
  pinnedRuntime,
  resolveRuntime,
  runtimeKitDir,
  writeRuntime,
} from "../../../src/shared/runtime";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wm-runtime-")));
  const home = join(root, "home");
  const bin = join(root, "toolchain", "bin");
  mkdirSync(home);
  mkdirSync(bin, { recursive: true });
  return { root, home, bin, scope: { home, protectedRoots: [join(root, "worktree"), join(root, "state")] } };
}

describe("scoped repository runtime", () => {
  test("default is unchanged; prefixes resolve, deduplicate and omit empty inherited PATH entries", async () => {
    const f = fixture();
    expect(await resolveRuntime([], f.scope, undefined)).toBeUndefined();
    const link = join(f.root, "bin-link");
    symlinkSync(f.bin, link);
    expect(await resolveRuntime([link, f.bin], f.scope, ":/usr/bin::/bin:")).toEqual({
      binPaths: [f.bin],
      readPaths: [f.bin],
      path: `${f.bin}:/usr/bin:/bin`,
    });
  });

  test("npm executable symlinks grant their package only, never the toolchain's parent", async () => {
    const f = fixture();
    const pkg = join(dirname(f.bin), "lib/node_modules/npm");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "bin/npm-cli.js"), "fixture");
    symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", join(f.bin, "npm"));
    const runtime = await resolveRuntime([f.bin], f.scope, "/usr/bin:/bin");
    expect(runtime?.readPaths).toEqual([f.bin, pkg]);
    expect(runtime?.readPaths).not.toContain(dirname(f.bin));
    expect(runtime?.readPaths).not.toContain(f.home);
  });

  test("trusted runtime kit lookup ignores HOME and state environment overrides", () => {
    const expected = join(userInfo().homedir, ".local/share/wingmate/kit/WMRT-1");
    const original = {
      HOME: process.env.HOME,
      WINGMATE_HOME: process.env.WINGMATE_HOME,
      WINGMATE_CONFIG_HOME: process.env.WINGMATE_CONFIG_HOME,
    };
    Object.assign(process.env, {
      HOME: "/fake/home",
      WINGMATE_HOME: "/fake/state",
      WINGMATE_CONFIG_HOME: "/fake/config",
    });
    try {
      expect(runtimeKitDir("WMRT-1")).toBe(expected);
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(() => runtimeKitDir("../../outside")).toThrow();
  });

  test("configured runtime rejects relative and repository-local inherited PATH entries", async () => {
    const f = fixture();
    const repository = join(f.root, "worktree");
    mkdirSync(join(repository, "bin"), { recursive: true });
    const linked = join(f.root, "repo-bin-link");
    symlinkSync(join(repository, "bin"), linked);
    const scope = { ...f.scope, repositoryRoots: [repository] };
    for (const path of [
      ".:/usr/bin",
      "bin:/usr/bin",
      `${join(repository, "bin")}:/usr/bin`,
      `${linked}:/usr/bin`,
    ])
      await expect(resolveRuntime([f.bin], scope, path)).rejects.toMatchObject({ code: "runtime_invalid" });
  });

  test("only a dedicated state/toolchains installation can be granted inside state", async () => {
    const f = fixture();
    const stateRoot = join(f.root, "state");
    const bin = join(stateRoot, "toolchains/node-22/bin");
    mkdirSync(bin, { recursive: true });
    const scope = { ...f.scope, stateRoot };
    const runtime = await resolveRuntime([bin], scope, "/usr/bin:/bin");
    expect(runtime?.readPaths).toEqual([bin]);
    for (const p of [
      stateRoot,
      join(stateRoot, "toolchains"),
      join(stateRoot, "kit"),
      join(stateRoot, "credentials"),
    ]) {
      mkdirSync(p, { recursive: true });
      await expect(resolveRuntime([p], scope, "/bin")).rejects.toMatchObject({ code: "runtime_invalid" });
    }
    symlinkSync(join(stateRoot, "credentials"), join(bin, "escape"));
    await expect(resolveRuntime([bin], scope, "/bin")).rejects.toMatchObject({ code: "runtime_invalid" });
  });

  test("refuses missing, non-directory, unsafe, broad, credential and state/worktree paths", async () => {
    const f = fixture();
    const file = join(f.root, "file");
    writeFileSync(file, "x");
    for (const p of [join(f.home, ".ssh"), join(f.root, "state/bin"), join(f.root, "worktree/bin")])
      mkdirSync(p, { recursive: true });
    for (const p of [
      "relative",
      "~/bin",
      `${f.bin}:/bin`,
      `${f.bin}\n`,
      `${f.bin}/*`,
      "/",
      "/usr",
      f.home,
      f.root,
      join(f.home, ".ssh"),
      join(f.root, "state/bin"),
      join(f.root, "worktree/bin"),
      join(f.root, "missing"),
      file,
    ])
      await expect(resolveRuntime([p], f.scope, "/usr/bin:/bin")).rejects.toMatchObject({
        code: "runtime_invalid",
      });
    await expect(resolveRuntime([f.bin], f.scope, "")).rejects.toMatchObject({ code: "runtime_invalid" });
    await expect(resolveRuntime([f.bin], f.scope, "/usr/bin\n")).rejects.toMatchObject({
      code: "runtime_invalid",
    });
  });

  test("refuses symlinked credentials, dangling executables and later replacement/missing runtime paths", async () => {
    const f = fixture();
    mkdirSync(join(f.home, ".ssh"));
    const secret = join(f.home, ".ssh/config");
    writeFileSync(secret, "fixture");
    symlinkSync(secret, join(f.bin, "bad"));
    await expect(resolveRuntime([f.bin], f.scope, "/bin")).rejects.toMatchObject({ code: "runtime_invalid" });
    rmSync(join(f.bin, "bad"));
    symlinkSync(join(f.root, "missing"), join(f.bin, "bad"));
    await expect(resolveRuntime([f.bin], f.scope, "/bin")).rejects.toMatchObject({ code: "runtime_invalid" });
    rmSync(join(f.bin, "bad"));
    const runtime = await resolveRuntime([f.bin], f.scope, "/usr/bin:/bin");
    if (!runtime) throw new Error("runtime missing");
    await assertRuntime(runtime);
    rmSync(f.bin, { recursive: true });
    await expect(assertRuntime(runtime)).rejects.toMatchObject({ code: "runtime_invalid" });
    symlinkSync(f.home, f.bin);
    await expect(assertRuntime(runtime)).rejects.toMatchObject({ code: "runtime_invalid" });
  });

  test("dispatcher copy rejects changed/removed launch runtime and permits legacy kits", async () => {
    const f = fixture();
    const kit = join(f.root, "kit");
    expect(await pinnedRuntime(kit, {})).toBeUndefined();
    const runtime = await resolveRuntime([f.bin], f.scope, "/usr/bin:/bin");
    if (!runtime) throw new Error("runtime missing");
    await expect(pinnedRuntime(kit, { runtime })).rejects.toMatchObject({ code: "runtime_invalid" });
    await writeRuntime(kit, runtime);
    expect(await pinnedRuntime(kit, { runtime })).toEqual(runtime);
    await expect(pinnedRuntime(kit, {})).rejects.toMatchObject({ code: "kit_tampered" });
    await expect(
      pinnedRuntime(kit, { runtime: { ...runtime, path: `${f.bin}:/other` } }),
    ).rejects.toMatchObject({ code: "kit_tampered" });
    expect(RuntimeSchema.safeParse({ ...runtime, path: "/other:/usr/bin" }).success).toBe(false);
    expect(RuntimeSchema.safeParse({ ...runtime, readPaths: ["/other/bin"] }).success).toBe(false);
  });
});
