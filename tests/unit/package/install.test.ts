import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageInfo, skillFiles } from "../../../src/package/bundle";
import { installSkill } from "../../../src/package/install";
import { HOSTS, type SetupHost } from "../../../src/setup/plan";
import { WingmateError } from "../../../src/shared/errors";

const roots: string[] = [];
async function temp() {
  const root = await fs.mkdtemp(join(tmpdir(), "wm-skill-install-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function assertSkill(directory: string) {
  const expected = skillFiles();
  expect(expected.some((file) => file.path === "SKILL.md")).toBe(true);
  for (const file of expected) {
    const path = join(directory, file.path);
    expect(await fs.readFile(path, "utf8")).toBe(file.content);
    expect((await fs.lstat(path)).isFile()).toBe(true);
  }
  const actual: string[] = [];
  for (const path of await fs.readdir(directory, { recursive: true }))
    if ((await fs.lstat(join(directory, path))).isFile()) actual.push(path);
  expect(actual.sort()).toEqual(expected.map((file) => file.path).sort());
}

describe("filesystem-only skill installation", () => {
  test("Codex and Claude Code default to their skill directories within the supplied temporary home", async () => {
    for (const host of ["codex", "claude-code"] as const) {
      const home = join(await temp(), "private-home");
      const result = await installSkill({ host }, { home });
      const expected = join(home, host === "codex" ? ".agents/skills/wingmate" : ".claude/skills/wingmate");
      expect(result).toEqual({
        installed: true,
        host,
        directory: expected,
        version: packageInfo().version,
        automationChanged: false,
      });
      await assertSkill(result.directory);
      expect(await fs.readdir(home)).toEqual([host === "codex" ? ".agents" : ".claude"]);
    }
  });

  test("every listed host accepts an explicit parent without installing into its default home", async () => {
    for (const host of HOSTS) {
      const root = await temp();
      const home = join(root, "untouched-home");
      const skillsDir = join(root, "chosen", "nested-skills");
      const result = await installSkill({ host, skillsDir }, { home });
      expect(result.directory).toBe(join(skillsDir, "wingmate"));
      expect(result.host).toBe(host);
      expect(result.automationChanged).toBe(false);
      await assertSkill(result.directory);
      expect(await fs.readdir(root)).toEqual(["chosen"]);
    }
  });

  test("Orca, Pi and OpenCode refuse to guess a launched agent's skill directory", async () => {
    for (const host of ["orca", "pi", "opencode"] as const) {
      const root = await temp();
      await expect(installSkill({ host }, { home: join(root, "missing-home") })).rejects.toMatchObject({
        code: "skill_directory_required",
      });
      expect(await fs.readdir(root)).toEqual([]);
    }
  });

  test("explicit filesystem names are preserved literally without shell expansion", async () => {
    const root = await temp();
    const skillsDir = join(root, "skills with spaces '$()'");
    const result = await installSkill({ host: "pi", skillsDir }, { home: root });
    expect(result.directory).toBe(join(skillsDir, "wingmate"));
    await assertSkill(result.directory);
    expect(await fs.readdir(root)).toEqual(["skills with spaces '$()'"]);
  });

  test("existing installed directories, owner-edited files and regular destination files remain untouched", async () => {
    const home = await temp();
    const result = await installSkill({ host: "codex" }, { home });
    const skill = join(result.directory, "SKILL.md");
    await fs.writeFile(skill, "owner-edited skill");
    const before = (await fs.readdir(result.directory, { recursive: true })).sort();
    await expect(installSkill({ host: "codex" }, { home })).rejects.toMatchObject({
      code: "skill_destination_exists",
    });
    expect(await fs.readFile(skill, "utf8")).toBe("owner-edited skill");
    expect((await fs.readdir(result.directory, { recursive: true })).sort()).toEqual(before);

    const skillsDir = join(home, "file-destination");
    await fs.mkdir(skillsDir);
    const destination = join(skillsDir, "wingmate");
    await fs.writeFile(destination, "owner file sentinel");
    await expect(installSkill({ host: "claude-code", skillsDir }, { home })).rejects.toMatchObject({
      code: "skill_destination_exists",
    });
    expect(await fs.readFile(destination, "utf8")).toBe("owner file sentinel");
    expect((await fs.lstat(destination)).isFile()).toBe(true);
  });

  test("existing and dangling destination symlinks are refused without following them", async () => {
    for (const dangling of [false, true]) {
      const root = await temp();
      const skillsDir = join(root, "skills");
      const target = join(root, "owner-target");
      await fs.mkdir(skillsDir);
      if (!dangling) {
        await fs.mkdir(target);
        await fs.writeFile(join(target, "sentinel"), "preserve target");
      }
      const destination = join(skillsDir, "wingmate");
      await fs.symlink(target, destination, "dir");
      await expect(installSkill({ host: "orca", skillsDir }, { home: root })).rejects.toMatchObject({
        code: "skill_destination_exists",
      });
      expect((await fs.lstat(destination)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(destination)).toBe(target);
      if (dangling) await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      else {
        expect(await fs.readdir(target)).toEqual(["sentinel"]);
        expect(await fs.readFile(join(target, "sentinel"), "utf8")).toBe("preserve target");
      }
    }
  });

  test("invalid hosts and paths refuse before any filesystem tree is created", async () => {
    const root = await temp();
    const home = join(root, "uncreated-home");
    for (const host of ["", "Orca", "claude", "unknown", "orca\n", "codex\u0000"])
      await expect(
        installSkill({ host: host as SetupHost, skillsDir: join(root, "skills") }, { home }),
      ).rejects.toMatchObject({
        code: "skill_host_invalid",
      });
    for (const bad of [
      "",
      " ",
      "bad\npath",
      "bad\tpath",
      "bad\u0000path",
      "bad\u007fpath",
      "bad\u0085path",
    ]) {
      await expect(installSkill({ host: "codex", skillsDir: bad }, { home })).rejects.toMatchObject({
        code: "skill_path_invalid",
      });
      await expect(installSkill({ host: "codex" }, { home: bad })).rejects.toMatchObject({
        code: "skill_path_invalid",
      });
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("an unwritable parent shape returns an actionable typed error without replacing anything", async () => {
    const root = await temp();
    const parent = join(root, "parent-file");
    await fs.writeFile(parent, "owner parent sentinel");
    let caught: unknown;
    try {
      await installSkill({ host: "codex", skillsDir: join(parent, "skills") }, { home: root });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WingmateError);
    expect((caught as WingmateError).code).toBe("skill_destination_unavailable");
    expect((caught as WingmateError).nextStep).toContain("writable");
    expect(await fs.readFile(parent, "utf8")).toBe("owner parent sentinel");
    expect(await fs.readdir(root)).toEqual(["parent-file"]);
  });

  test("a failed content write preserves partial output, gives no success receipt and refuses a retry overwrite", async () => {
    const root = await temp();
    const skillsDir = join(root, "skills");
    const originalWrite = fs.writeFile;
    let writes = 0;
    const failure = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      writes += 1;
      if (writes === 2) throw Object.assign(new Error("controlled write failure"), { code: "ENOSPC" });
      return originalWrite(...args);
    });
    let caught: unknown;
    try {
      await installSkill({ host: "codex", skillsDir }, { home: root });
    } catch (error) {
      caught = error;
    } finally {
      failure.mockRestore();
    }
    const directory = join(skillsDir, "wingmate");
    expect(caught).toBeInstanceOf(WingmateError);
    expect((caught as WingmateError).code).toBe("skill_install_incomplete");
    expect((caught as WingmateError).nextStep).toContain("partial skill tree");
    const first = skillFiles()[0];
    if (!first) throw new Error("embedded skill has no files");
    expect(await fs.readFile(join(directory, first.path), "utf8")).toBe(first.content);
    expect((await fs.lstat(directory)).isDirectory()).toBe(true);
    expect(writes).toBe(2);
    await expect(installSkill({ host: "codex", skillsDir }, { home: root })).rejects.toMatchObject({
      code: "skill_destination_exists",
    });
    expect(await fs.readFile(join(directory, first.path), "utf8")).toBe(first.content);
  });
});
