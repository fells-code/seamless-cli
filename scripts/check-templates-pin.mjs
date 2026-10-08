// Fails when SEAMLESS_TEMPLATES_COMMIT is not the commit SEAMLESS_TEMPLATES_REF points
// at. Scaffolds download by the commit, so bumping the tag alone would leave new
// projects on the old templates with nothing to say so.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const IMAGES = "src/core/images.ts";

function constant(source, name) {
  const match = new RegExp(`export const ${name} = "([^"]+)";`).exec(source);
  if (!match) throw new Error(`Could not read ${name} from ${IMAGES}.`);
  return match[1];
}

const source = await readFile(IMAGES, "utf8");
const repo = constant(source, "SEAMLESS_TEMPLATES_REPO");
const ref = constant(source, "SEAMLESS_TEMPLATES_REF");
const pinned = constant(source, "SEAMLESS_TEMPLATES_COMMIT");

// An annotated tag lists the tag object under the plain name and the commit under the
// peeled `^{}` name; a lightweight tag lists only the plain name, which is the commit.
const refs = new Map(
  execFileSync(
    "git",
    ["ls-remote", `https://github.com/${repo}.git`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").reverse()),
);
const resolved = refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/tags/${ref}`);

if (!resolved) {
  console.error(`${repo} has no tag ${ref}. Release it before pinning to it.`);
  process.exit(1);
}
if (resolved !== pinned) {
  console.error(
    `SEAMLESS_TEMPLATES_COMMIT is ${pinned}, but ${repo} ${ref} points at ${resolved}. Set SEAMLESS_TEMPLATES_COMMIT to ${resolved}.`,
  );
  process.exit(1);
}
console.log(`SEAMLESS_TEMPLATES_COMMIT matches ${repo} ${ref} (${resolved}).`);
