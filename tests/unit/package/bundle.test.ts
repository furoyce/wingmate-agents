import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPackage, packageInfo } from "../../../src/package/bundle";

const roots: string[] = [];
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "wm-package-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("export is a self-contained skill bundle with verifiable content and no owner configuration", async () => {
  const root = await temp();
  // Adjacent owner files must not become distribution payloads.
  await writeFile(join(root, "credentials.json"), "private-owner-sentinel");
  const destination = join(root, "bundle");
  const result = await exportPackage(destination);
  const manifest = JSON.parse(await readFile(join(destination, "wingmate-package.json"), "utf8"));
  expect(manifest).toEqual(packageInfo());
  expect(result.installed).toBe(false);
  expect(result.automationChanged).toBe(false);
  const paths = (await readdir(destination, { recursive: true })).sort();
  expect(paths).toEqual([
    "capabilities.json",
    "skills",
    "skills/wingmate",
    "skills/wingmate/SKILL.md",
    "skills/wingmate/agents",
    "skills/wingmate/agents/openai.yaml",
    "skills/wingmate/references",
    "skills/wingmate/references/operations.md",
    "wingmate-package.json",
  ]);
  for (const file of result.files) {
    const content = await readFile(join(destination, file.path));
    expect(content.byteLength).toBe(file.bytes);
    expect(createHash("sha256").update(content).digest("hex")).toBe(file.sha256);
    expect(content.toString()).not.toContain("private-owner-sentinel");
  }
  // A relative reference stays usable after the bundle is moved away from the checkout.
  const skill = await readFile(join(destination, manifest.entrypoint), "utf8");
  expect(skill).toContain("(references/operations.md#onboarding)");
  expect(await readFile(join(destination, "skills/wingmate/references/operations.md"), "utf8")).toContain(
    "## Onboarding",
  );
});

test("repeated export refuses existing output and preserves user edits", async () => {
  const destination = join(await temp(), "bundle");
  await exportPackage(destination);
  const skill = join(destination, "skills/wingmate/SKILL.md");
  await writeFile(skill, "owner customization");
  await expect(exportPackage(destination)).rejects.toMatchObject({ code: "package_destination_exists" });
  expect(await readFile(skill, "utf8")).toBe("owner customization");
});

test("an existing symlink is not followed as an export destination", async () => {
  const root = await temp();
  const destination = join(root, "link");
  await symlink(root, destination, "dir");
  await expect(exportPackage(destination)).rejects.toMatchObject({ code: "package_destination_exists" });
  expect(await readdir(root)).toEqual(["link"]);
});

test("invalid paths fail before a directory can be created", async () => {
  for (const path of ["", " ", "bad\npath", "bad\u0000path"])
    await expect(exportPackage(path)).rejects.toMatchObject({ code: "package_path_invalid" });
});

test("capability metadata distinguishes a skill reader from an implemented scheduler", () => {
  const { capabilities } = packageInfo();
  expect(capabilities.execution.backend).toBe("orca");
  expect(capabilities.scheduling.implemented).toEqual(["orca"]);
  expect(capabilities.scheduling.notImplemented).toContain("codex-scheduled-tasks");
  expect(capabilities.unmanagedFrontends).toContain("opencode");
  expect(capabilities.agentInterface.automaticHostInstallation).toBe(false);
});
