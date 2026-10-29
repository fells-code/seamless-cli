import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureGitignore, SECRET_IGNORES } from "./gitignore.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-gitignore-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = () => fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");

describe("ensureGitignore", () => {
  it("creates the file with each pattern on its own line", () => {
    ensureGitignore(dir, [".env", "keys/"]);
    expect(read()).toBe(".env\nkeys/\n");
  });

  it("appends only the patterns missing, keeping the user's lines", () => {
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.env");

    ensureGitignore(dir, [".env", "keys/"]);

    expect(read()).toBe("node_modules/\n.env\nkeys/\n");
  });

  it("leaves a file that already lists everything untouched", () => {
    fs.writeFileSync(path.join(dir, ".gitignore"), "keys/\n.env\n");

    ensureGitignore(dir, [".env", "keys/"]);

    expect(read()).toBe("keys/\n.env\n");
  });

  it("has git ignore every service's .env and key file, but not .env.example", () => {
    // A git hook running this suite exports GIT_DIR and friends, which would
    // point these commands at the enclosing repository.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    execFileSync("git", ["init", "-q"], { cwd: dir, env });
    ensureGitignore(dir, SECRET_IGNORES);

    const ignored = (file: string) => {
      try {
        execFileSync("git", ["check-ignore", "-q", file], { cwd: dir, env });
        return true;
      } catch {
        return false;
      }
    };

    for (const file of ["auth/.env", "api/.env", "web/.env", ".env.local", "auth/keys/dev.pem"]) {
      expect(ignored(file), file).toBe(true);
    }
    expect(ignored("api/.env.example")).toBe(false);
    expect(ignored("docker-compose.yml")).toBe(false);
  });
});
