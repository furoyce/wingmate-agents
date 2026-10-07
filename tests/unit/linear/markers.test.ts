// tests/unit/linear/markers.test.ts
import { describe, expect, test } from "bun:test";
import { MARK, findMarked, parseQuestionId } from "../../../src/linear/markers";

describe("markers", () => {
  test("finds the status comment by marker and parses a question id", () => {
    const comments = [
      { id: "a", body: "hello" },
      { id: "b", body: `${MARK.status}\n| Stage |` },
      { id: "c", body: `${MARK.question("01HZZ")}\nQ?` },
    ];
    expect(findMarked(comments, MARK.status)?.id).toBe("b");
    expect(parseQuestionId(comments[2]?.body ?? "")).toBe("01HZZ");
    expect(parseQuestionId("no marker")).toBeNull();
  });
});
