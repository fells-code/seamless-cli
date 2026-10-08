import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergeEnvFile } from "./envFile.js";

let file: string;

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "seamless-env-")), ".env");
});
afterEach(() => {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

describe("mergeEnvFile", () => {
  it("keeps every line it does not own", () => {
    fs.writeFileSync(
      file,
      "# My app\nDATABASE_URL=postgres://me@db/app\n\n# Auth\nAUTH_SERVER_URL=http://old\nCOOKIE_SIGNING_KEY=mine\n",
    );

    const result = mergeEnvFile(file, {
      set: { AUTH_SERVER_URL: "http://localhost:5312", JWKS_KID: "dev-main" },
      defaults: { COOKIE_SIGNING_KEY: "generated", UI_ORIGINS: "http://localhost:5173" },
    });

    expect(fs.readFileSync(file, "utf-8")).toBe(
      "# My app\nDATABASE_URL=postgres://me@db/app\n\n# Auth\nAUTH_SERVER_URL=http://localhost:5312\nCOOKIE_SIGNING_KEY=mine\n\n# Seamless Auth\nJWKS_KID=dev-main\nUI_ORIGINS=http://localhost:5173\n",
    );
    expect(result.written.sort()).toEqual(["AUTH_SERVER_URL", "JWKS_KID", "UI_ORIGINS"]);
    expect(result.kept).toEqual(["COOKIE_SIGNING_KEY"]);
  });

  it("creates the file and quotes what needs quoting", () => {
    mergeEnvFile(file, { set: { A: "plain", B: "has space" } });
    expect(fs.readFileSync(file, "utf-8")).toBe('# Seamless Auth\nA=plain\nB="has space"\n');
  });

  it("leaves an unchanged file untouched", () => {
    fs.writeFileSync(file, "# unchanged\nA=1\n");
    const before = fs.statSync(file).mtimeMs;
    const result = mergeEnvFile(file, { set: { A: "1" } });
    expect(result).toEqual({ written: [], kept: ["A"] });
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it("updates an exported assignment in place", () => {
    fs.writeFileSync(file, "export A=old\n");
    mergeEnvFile(file, { set: { A: "new" } });
    expect(fs.readFileSync(file, "utf-8")).toBe("A=new\n");
  });
});
