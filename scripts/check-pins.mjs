// Fails when a commit or image digest pinned in src/core/images.ts is not what its tag
// points at. Scaffolds download and verify by the pin, so bumping a tag alone would
// leave new projects on the old release, or fail them, with nothing here to say so.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const IMAGES = "src/core/images.ts";

function constant(source, name) {
  const match = new RegExp(`export const ${name} =\\s*"([^"]+)";`).exec(source);
  if (!match) throw new Error(`Could not read ${name} from ${IMAGES}.`);
  return match[1];
}

// An annotated tag lists the tag object under the plain name and the commit under the
// peeled `^{}` name; a lightweight tag lists only the plain name, which is the commit.
function tagCommit(repo, tag) {
  const refs = new Map(
    execFileSync(
      "git",
      ["ls-remote", `https://github.com/${repo}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t").reverse()),
  );
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function imageDigest(image, tag) {
  const tokenRes = await fetch(`https://ghcr.io/token?scope=repository:${image}:pull`);
  if (!tokenRes.ok) {
    throw new Error(`ghcr.io refused a pull token for ${image} (${tokenRes.status}).`);
  }
  const { token } = await tokenRes.json();
  const res = await fetch(`https://ghcr.io/v2/${image}/manifests/${tag}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_TYPES },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`ghcr.io returned ${res.status} for ${image}:${tag}.`);
  return res.headers.get("docker-content-digest") ?? undefined;
}

const source = await readFile(IMAGES, "utf8");
const apiTag = constant(source, "SEAMLESS_AUTH_API_VERSION");
const dashboardTag = constant(source, "SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION");

const commits = [
  {
    name: "SEAMLESS_TEMPLATES_COMMIT",
    repo: constant(source, "SEAMLESS_TEMPLATES_REPO"),
    tag: constant(source, "SEAMLESS_TEMPLATES_REF"),
  },
  { name: "SEAMLESS_AUTH_API_COMMIT", repo: "fells-code/seamless-auth-api", tag: apiTag },
  {
    name: "SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT",
    repo: constant(source, "SEAMLESS_AUTH_ADMIN_DASHBOARD_REPO"),
    tag: dashboardTag,
  },
];

const digests = [
  {
    name: "SEAMLESS_AUTH_API_IMAGE_DIGEST",
    image: "fells-code/seamless-auth-api",
    tag: apiTag,
  },
  {
    name: "SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE_DIGEST",
    image: "fells-code/seamless-auth-admin-dashboard",
    tag: dashboardTag,
  },
];

let failed = false;

function report(name, pinned, resolved, where, missing) {
  if (!resolved) {
    console.error(missing);
    failed = true;
  } else if (resolved !== pinned) {
    console.error(`${name} is ${pinned}, but ${where} is ${resolved}. Set ${name} to ${resolved}.`);
    failed = true;
  } else {
    console.log(`${name} matches ${where} (${resolved}).`);
  }
}

for (const { name, repo, tag } of commits) {
  report(
    name,
    constant(source, name),
    tagCommit(repo, tag),
    `${repo} ${tag}`,
    `${repo} has no tag ${tag}. Release it before pinning to it.`,
  );
}

for (const { name, image, tag } of digests) {
  report(
    name,
    constant(source, name),
    await imageDigest(image, tag),
    `ghcr.io/${image}:${tag}`,
    `ghcr.io/${image} has no tag ${tag}. Publish it before pinning to it.`,
  );
}

if (failed) process.exit(1);
