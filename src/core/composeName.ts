import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

const COMPOSE_NAME_LINE = /^name:\s*["']?([a-z0-9][a-z0-9_-]*)["']?\s*$/m;

/**
 * A directory's name reduced to what Compose accepts as a project name: lowercase
 * letters, digits, dashes and underscores, starting with a letter or digit.
 */
export function composeSlug(root: string): string {
  const base = path
    .basename(path.resolve(root))
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+|[-_]+$/g, "");
  return base || "app";
}

/**
 * The project name for a scaffolded stack. The suffix is random because the
 * directory name alone repeats: everyone who follows the quickstart twice has two
 * "my-app" projects, and Compose would hand the second one the first one's built
 * images and its database volume.
 */
export function uniqueComposeProjectName(root: string): string {
  return `${composeSlug(root)}-${randomBytes(3).toString("hex")}`;
}

// The name an earlier run wrote, so a re-run (or a hand edit) keeps its volumes.
export function existingComposeProjectName(
  composePath: string,
): string | undefined {
  if (!fs.existsSync(composePath)) return undefined;
  return COMPOSE_NAME_LINE.exec(fs.readFileSync(composePath, "utf-8"))?.[1];
}
