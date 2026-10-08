import path from "path";

/**
 * Resolves an archive entry against the destination, refusing anything that escapes it.
 *
 * Entry names come from the archive, so a `../` in one would otherwise write wherever
 * the developer can write. Not reachable today, since every archive is our own
 * repository over https, but the check is what keeps a compromise of that source from
 * becoming an arbitrary write. Failing the scaffold rather than skipping the entry, so
 * a tampered archive cannot quietly produce a partial project.
 */
export function containedPath(destDir: string, rel: string, what: string): string {
  const root = path.resolve(destDir);
  const out = path.resolve(root, rel);
  if (out !== root && !out.startsWith(root + path.sep)) {
    throw new Error(
      `The ${what} archive contains an entry that would write outside the project: ${rel}`,
    );
  }
  return out;
}
