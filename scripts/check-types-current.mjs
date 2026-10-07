// Fails when this package or a workspace package pins @seamless-auth/types to a minor older than
// the latest published one. Under 0.x a caret range locks the minor, so a stale
// pin never picks up contract changes on its own.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const PACKAGE = "@seamless-auth/types";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function parseVersion(value) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? match.slice(1, 4).map(Number) : null;
}

async function latestPublished() {
  const response = await fetch(
    `https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}`,
    { headers: { accept: "application/vnd.npm.install-v1+json" } },
  );
  if (!response.ok) {
    throw new Error(
      `Could not read ${PACKAGE} from the npm registry: HTTP ${response.status}`,
    );
  }
  const latest = (await response.json())["dist-tags"]?.latest;
  if (!latest) {
    throw new Error(`The npm registry returned no latest tag for ${PACKAGE}.`);
  }
  return latest;
}

async function manifestPaths(root) {
  const paths = [join(root, "package.json")];
  const packagesDir = join(root, "packages");
  const entries = await readdir(packagesDir, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      paths.push(join(packagesDir, entry.name, "package.json"));
    }
  }
  return paths;
}

async function pinnedRanges(root) {
  const pins = [];
  for (const manifestPath of await manifestPaths(root)) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    for (const field of DEPENDENCY_FIELDS) {
      const range = manifest[field]?.[PACKAGE];
      if (range) pins.push({ name: manifest.name, field, range });
    }
  }
  return pins;
}

const latest = await latestPublished();
const [latestMajor, latestMinor] = parseVersion(latest);
const pins = await pinnedRanges(process.cwd());
let behind = 0;

for (const pin of pins) {
  const pinned = parseVersion(pin.range);
  if (!pinned) {
    console.error(
      `${pin.name} ${pin.field}: cannot read a version from ${PACKAGE} range "${pin.range}".`,
    );
    behind++;
    continue;
  }
  const [major, minor] = pinned;
  if (major < latestMajor || (major === latestMajor && minor < latestMinor)) {
    console.error(
      `${pin.name} ${pin.field}: ${PACKAGE} is pinned to "${pin.range}" but the latest published version is ${latest}. Bump it to "^${latestMajor}.${latestMinor}.0".`,
    );
    behind++;
  } else {
    console.log(
      `${pin.name} ${pin.field}: ${PACKAGE} "${pin.range}" is current (latest ${latest}).`,
    );
  }
}

if (pins.length === 0) {
  console.log(`No workspace package depends on ${PACKAGE}.`);
}

if (behind > 0) {
  process.exit(1);
}
