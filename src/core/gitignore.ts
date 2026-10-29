import fs from "fs";
import path from "path";

// What a scaffold must never commit: the generated .env files (every service's
// secrets live there) and the auth server's signing key material.
export const SECRET_IGNORES = [".env", ".env.*", "!.env.example", "keys/", "*.pem"];

/**
 * Adds each pattern to `<dir>/.gitignore` that it does not already list, creating
 * the file when there is none. Lines already there, the user's own included, stay.
 */
export function ensureGitignore(dir: string, patterns: string[]): void {
  const file = path.join(dir, ".gitignore");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = patterns.filter((pattern) => !present.has(pattern));
  if (missing.length === 0 && existing !== "") return;

  const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  fs.writeFileSync(file, prefix + missing.map((pattern) => `${pattern}\n`).join(""));
}
