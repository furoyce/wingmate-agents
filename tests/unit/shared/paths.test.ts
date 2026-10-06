import { describe, expect, test } from "bun:test";
import { homeDirs } from "../../../src/shared/paths";
describe("paths", () => {
  test("honors WINGMATE_HOME and WINGMATE_CONFIG_HOME", () => {
    const d = homeDirs({
      WINGMATE_HOME: "/tmp/wm-state",
      WINGMATE_CONFIG_HOME: "/tmp/wm-config",
      HOME: "/Users/x",
    });
    expect(d.state).toBe("/tmp/wm-state");
    expect(d.records).toBe("/tmp/wm-state/records");
    expect(d.journal).toBe("/tmp/wm-state/journal");
    expect(d.config).toBe("/tmp/wm-config");
  });
  test("defaults under HOME", () => {
    const d = homeDirs({ HOME: "/Users/x" });
    expect(d.state).toBe("/Users/x/.local/share/wingmate");
    expect(d.config).toBe("/Users/x/.config/wingmate");
    expect(d.kit).toBe("/Users/x/.local/share/wingmate/kit");
  });
});
