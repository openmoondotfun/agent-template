import { describe, expect, it } from "vitest";
import { positionalWords } from "./args";

const BROWSE_VALUE_FLAGS = ["--page", "--page-size"];

describe("positionalWords", () => {
  it("drops a value flag together with its value", () => {
    expect(positionalWords(["swap", "--page", "2"], BROWSE_VALUE_FLAGS)).toEqual(["swap"]);
  });

  it("keeps every word of a multi-word query", () => {
    expect(
      positionalWords(["token", "swap", "--page-size", "5", "--page", "3"], BROWSE_VALUE_FLAGS)
    ).toEqual(["token", "swap"]);
  });

  it("returns nothing when there are only flags", () => {
    expect(positionalWords(["--page", "2"], BROWSE_VALUE_FLAGS)).toEqual([]);
  });
});
