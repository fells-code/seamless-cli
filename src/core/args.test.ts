import { describe, expect, it } from "vitest";
import {
  extractFlag,
  extractRepeatedFlag,
  extractSwitch,
  hasHelpFlag,
} from "./args.js";

describe("hasHelpFlag", () => {
  it.each(["-h", "--help"])("detects %s", (flag) => {
    expect(hasHelpFlag(["sub", flag])).toBe(true);
  });

  it("returns false when no help flag is present", () => {
    expect(hasHelpFlag(["set", "key", "value"])).toBe(false);
    expect(hasHelpFlag([])).toBe(false);
  });

  it("treats a help flag after -- as an operand, not a request for help", () => {
    expect(hasHelpFlag(["set", "key", "--", "-h"])).toBe(false);
  });
});

describe("extractFlag", () => {
  it("extracts a --flag value pair and removes both from rest", () => {
    const result = extractFlag(["--name", "acme", "positional"], "name");
    expect(result).toEqual({ value: "acme", rest: ["positional"] });
  });

  it("extracts a --flag=value form", () => {
    const result = extractFlag(["--name=acme", "positional"], "name");
    expect(result).toEqual({ value: "acme", rest: ["positional"] });
  });

  it("returns undefined value when the flag is missing", () => {
    const result = extractFlag(["positional"], "name");
    expect(result).toEqual({ value: undefined, rest: ["positional"] });
  });

  it("keeps the last occurrence when the flag is repeated", () => {
    const result = extractFlag(["--name", "first", "--name", "second"], "name");
    expect(result).toEqual({ value: "second", rest: [] });
  });

  it("does not confuse a similarly prefixed flag with the target flag", () => {
    const result = extractFlag(["--nameOther", "x", "--name", "y"], "name");
    expect(result).toEqual({ value: "y", rest: ["--nameOther", "x"] });
  });

  it("returns an empty rest and undefined value for an empty args list", () => {
    const result = extractFlag([], "name");
    expect(result).toEqual({ value: undefined, rest: [] });
  });
});

describe("extractRepeatedFlag", () => {
  it("collects every value in order, in both spellings", () => {
    expect(
      extractRepeatedFlag(["a", "--uri", "x", "--uri=y", "b", "--uri"], "uri"),
    ).toEqual({ values: ["x", "y", ""], rest: ["a", "b"] });
  });

  it("returns no values when the flag is absent", () => {
    expect(extractRepeatedFlag(["a"], "uri")).toEqual({ values: [], rest: ["a"] });
  });
});

describe("extractSwitch", () => {
  it("reads the last of a pair of switches", () => {
    expect(extractSwitch(["--on", "a", "--off"], "on", "off")).toEqual({
      value: false,
      rest: ["a"],
    });
    expect(extractSwitch(["--on"], "on", "off").value).toBe(true);
    expect(extractSwitch(["a"], "on", "off")).toEqual({ rest: ["a"] });
  });
});
