import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEnv, parseEnvString, writeEnv } from "./env.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-env-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseEnv", () => {
  it("parses simple key=value lines from a file", () => {
    const file = path.join(tmpDir, ".env");
    fs.writeFileSync(file, "FOO=bar\nBAZ=qux\n");

    expect(parseEnv(file)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips blank lines and comment lines", () => {
    const file = path.join(tmpDir, ".env");
    fs.writeFileSync(file, "\n# a comment\nFOO=bar\n\n#another\nBAZ=qux\n");

    expect(parseEnv(file)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips lines with no key", () => {
    const file = path.join(tmpDir, ".env");
    fs.writeFileSync(file, "=novalue\nFOO=bar\n");

    expect(parseEnv(file)).toEqual({ FOO: "bar" });
  });

  it("trims whitespace around key and value", () => {
    const file = path.join(tmpDir, ".env");
    fs.writeFileSync(file, "  FOO  =  bar  \n");

    expect(parseEnv(file)).toEqual({ FOO: "bar" });
  });

  it("rejoins values that contain an equals sign", () => {
    const file = path.join(tmpDir, ".env");
    fs.writeFileSync(file, "URL=https://example.com?a=1&b=2\n");

    expect(parseEnv(file)).toEqual({ URL: "https://example.com?a=1&b=2" });
  });

  it("unquotes double-quoted values and unescapes them", () => {
    const file = path.join(tmpDir, ".env");
    fs.writeFileSync(file, 'FOO="bar baz"\nMULTI="a\\nb"\n');

    expect(parseEnv(file)).toEqual({ FOO: "bar baz", MULTI: "a\nb" });
  });

  it("treats single-quoted values as literal", () => {
    const file = path.join(tmpDir, ".env");
    fs.writeFileSync(file, "FOO='a\\nb'\n");

    expect(parseEnv(file)).toEqual({ FOO: "a\\nb" });
  });
});

describe("parseEnvString", () => {
  it("parses simple key=value lines from a string", () => {
    expect(parseEnvString("FOO=bar\nBAZ=qux\n")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("skips blank lines and comment lines", () => {
    expect(parseEnvString("\n# a comment\nFOO=bar\n\n#another\n")).toEqual({
      FOO: "bar",
    });
  });

  it("skips lines with no key", () => {
    expect(parseEnvString("=novalue\nFOO=bar\n")).toEqual({ FOO: "bar" });
  });

  it("trims whitespace around key and value", () => {
    expect(parseEnvString("  FOO  =  bar  ")).toEqual({ FOO: "bar" });
  });

  it("rejoins values that contain an equals sign", () => {
    expect(parseEnvString("A=1=2=3")).toEqual({ A: "1=2=3" });
  });

  it("returns an empty object for empty content", () => {
    expect(parseEnvString("")).toEqual({});
  });
});

describe("writeEnv", () => {
  it("writes key=value pairs, one per line, with a trailing newline", () => {
    const file = path.join(tmpDir, "out.env");
    writeEnv(file, { FOO: "bar", BAZ: "qux" });

    expect(fs.readFileSync(file, "utf-8")).toBe("FOO=bar\nBAZ=qux\n");
  });

  it("writes just a trailing newline for an empty env object", () => {
    const file = path.join(tmpDir, "empty.env");
    writeEnv(file, {});

    expect(fs.readFileSync(file, "utf-8")).toBe("\n");
  });

  it("round-trips through parseEnv", () => {
    const file = path.join(tmpDir, "roundtrip.env");
    const original = { A: "1", B: "two", C: "" };
    writeEnv(file, original);

    expect(parseEnv(file)).toEqual(original);
  });

  it("quotes values with characters dotenv would misread, and round-trips them", () => {
    const file = path.join(tmpDir, "special.env");
    const original = {
      HASH: "abc#notacomment",
      SPACED: "with spaces",
      QUOTED: 'a"b',
      NEWLINE: "line1\nline2",
      BACKSLASH: "a\\b",
      LEADING: " padded ",
      PLAIN: "simple-token_123",
    };
    writeEnv(file, original);

    const raw = fs.readFileSync(file, "utf-8");
    // The `#` value must be quoted so a dotenv parser doesn't treat it as a comment,
    // and a simple token must stay bare.
    expect(raw).toContain('HASH="abc#notacomment"');
    expect(raw).toContain("PLAIN=simple-token_123");
    expect(raw).not.toContain("PLAIN=\"");

    expect(parseEnv(file)).toEqual(original);
  });
});

describe.skipIf(process.platform === "win32")("writeEnv file mode", () => {
  it("creates the file readable by its owner only", () => {
    const file = path.join(tmpDir, ".env");
    writeEnv(file, { SECRET: "s" });

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("tightens a file that already exists with a wider mode", () => {
    const file = path.join(tmpDir, ".env");
    fs.writeFileSync(file, "OLD=1\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    writeEnv(file, { SECRET: "s" });

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf-8")).toBe("SECRET=s\n");
  });
});
