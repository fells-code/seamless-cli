import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";

import { containedPath } from "../../core/archive.js";
import {
  SEAMLESS_AUTH_ADMIN_DASHBOARD_REF,
  SEAMLESS_AUTH_ADMIN_DASHBOARD_REPO,
} from "../../core/images.js";

// Mirrors the template source's ignore list: these are checkout artifacts, not
// project files, and a GitHub archive can carry the last two.
const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  ".github",
  ".DS_Store",
]);

export const ADMIN_DIR = "admin";

/**
 * Downloads the admin dashboard into `<root>/admin` for `--admin=source`.
 *
 * A GitHub archive rather than a `git clone`: it matches how the starter
 * templates arrive, needs no git binary on the developer's machine, and pins to
 * the same ref the official image is built from, so the source and image modes
 * scaffold the same dashboard. The tradeoff is that `admin/` arrives without
 * history, which is the right default for a directory meant to be committed into
 * the developer's own repository.
 *
 * Override the ref with SEAMLESS_ADMIN_DASHBOARD_REF, or scaffold from a local
 * checkout with SEAMLESS_ADMIN_DASHBOARD_DIR, mirroring the template overrides.
 */
export async function generateAdminSource(root: string): Promise<string> {
  const destDir = path.join(root, ADMIN_DIR);
  const localDir = process.env.SEAMLESS_ADMIN_DASHBOARD_DIR;

  if (localDir) {
    copyDir(path.resolve(localDir), destDir);
  } else {
    const ref =
      process.env.SEAMLESS_ADMIN_DASHBOARD_REF ?? SEAMLESS_AUTH_ADMIN_DASHBOARD_REF;
    await unpackArchive(SEAMLESS_AUTH_ADMIN_DASHBOARD_REPO, ref, destDir);
  }

  // The compose service is `build: ./admin`, so without this the stack fails on a
  // missing build context rather than on anything the developer can act on.
  if (!fs.existsSync(path.join(destDir, "Dockerfile"))) {
    throw new Error(
      `The admin dashboard was unpacked into ${ADMIN_DIR}/ but has no Dockerfile, so \`docker compose up\` could not build it. Re-run with --admin=image to use the published image instead.`,
    );
  }

  return destDir;
}

async function unpackArchive(
  repo: string,
  ref: string,
  destDir: string,
): Promise<void> {
  const url = `https://github.com/${repo}/archive/${ref}.zip`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download the admin dashboard (${res.status}) from ${url}.`,
    );
  }

  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new Error("The downloaded admin dashboard archive was empty.");
  }

  // GitHub archives nest everything under a single top-level directory.
  const prefix = `${entries[0].entryName.split("/")[0]}/`;

  for (const entry of entries) {
    if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue;
    const rel = entry.entryName.slice(prefix.length);
    if (rel.split("/").some((seg) => IGNORED_NAMES.has(seg))) continue;

    const out = containedPath(destDir, rel, "admin dashboard");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, entry.getData());
  }
}

function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (IGNORED_NAMES.has(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      copyDir(from, to);
    } else if (stat.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}
