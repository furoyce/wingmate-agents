import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../../src/config/load";
import { route } from "../../../src/policy/routing";

describe("route", () => {
  test("title keyword wins, description is a tiebreaker, default otherwise, both → ambiguous", async () => {
    const cfg = await loadConfig("config/projects.yaml");
    const p = cfg.projects.bouncr;
    if (!p) throw new Error("bouncr project missing from config/projects.yaml");
    expect(route(p, "iOS leaderboard", null)).toMatchObject({ repo: "api", basis: "rule" });
    expect(route(p, "Add level select", "web only")).toMatchObject({ repo: "web", basis: "rule" });
    expect(route(p, "Fix typo", null)).toMatchObject({ repo: "api", basis: "default" });
    expect(route(p, "Web and iOS leaderboard", null)).toMatchObject({
      repo: "api",
      basis: "ambiguous",
      candidates: ["api", "web"],
    });
    expect(route(p, "Leaderboard", "touch the web game")).toMatchObject({ repo: "web", basis: "rule" });
  });
  test("keywords match whole words only and a project without rules routes to its default", async () => {
    const cfg = await loadConfig("config/projects.yaml");
    const bouncr = cfg.projects.bouncr;
    const sd = cfg.projects["smart-dispatcher"];
    if (!bouncr || !sd) throw new Error("pilot projects missing");
    expect(route(bouncr, "Apiary notes", null)).toMatchObject({ basis: "default" });
    expect(route(sd, "ios web game", "anything")).toMatchObject({
      repo: "main",
      basis: "default",
      candidates: [],
    });
  });
});
