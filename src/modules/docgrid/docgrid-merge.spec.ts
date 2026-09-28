import { mergeText } from "./docgrid-merge";
describe("three-way document merge", () => {
  it("preserves independent edits", () =>
    expect(mergeText("a\nb\nc", "A\nb\nc", "a\nb\nC")).toEqual({
      conflict: false,
      content: "A\nb\nC",
    }));
  it("does not revert target edits", () =>
    expect(mergeText("a", "a", "b").content).toBe("b"));
  it("reports overlapping edits", () =>
    expect(mergeText("a\nb", "a\nB", "a\nC").conflict).toBe(true));
  it("accepts identical edits once", () =>
    expect(mergeText("a", "a\nb", "a\nb").content).toBe("a\nb"));
  it("fails closed without a merge base", () =>
    expect(mergeText(null, "a", "b").conflict).toBe(true));
  it("preserves independent insertions", () =>
    expect(mergeText("a\nb\nc", "a\nx\nb\nc", "a\nb\nc\ny").content).toBe(
      "a\nx\nb\nc\ny",
    ));
  it("conflicts on insertions at the same position", () =>
    expect(mergeText("a", "x\na", "y\na").conflict).toBe(true));
  it("combines deletion with unrelated edit", () =>
    expect(mergeText("a\nb\nc", "a\nc", "a\nb\nC").content).toBe("a\nC"));
  it("preserves trailing newline", () =>
    expect(mergeText("a\nb\n", "A\nb\n", "a\nB\n").content).toBe("A\nB\n"));
});

