// Baked into each scaffold's own docker-compose.yml at generation time, so a
// bump here reaches new projects only. An existing project keeps the major it was
// scaffolded with, and never has its data directory pulled out from under it.
export const POSTGRES_IMAGE = "postgres:18";

// Each tag below is paired with the commit (and image digest) it resolved to when
// bumped, because a tag can be moved and what it names is then built and run on the
// developer's machine. Bump them together: `npm run check:templates-pin` (run in CI)
// checks every pin in this file against its tag and fails when one disagrees.
export const SEAMLESS_AUTH_API_VERSION = "v0.20.0";

export const SEAMLESS_AUTH_API_COMMIT = "82aef89a82c6d2bdfc196bf5cc051eac6c23076a";

export const SEAMLESS_AUTH_API_IMAGE_DIGEST =
  "sha256:477eb6dc1214528a5026ff1111a6d72063fa592f868c0e62d3ec986ab6376e6d";

export const SEAMLESS_AUTH_API_IMAGE = `ghcr.io/fells-code/seamless-auth-api:${SEAMLESS_AUTH_API_VERSION}@${SEAMLESS_AUTH_API_IMAGE_DIGEST}`;

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION = "v0.11.0";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE_DIGEST =
  "sha256:8d8257e531243debd14094e41448650cd42b1c62bdb33f5e7c7e9d784925811f";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE = `ghcr.io/fells-code/seamless-auth-admin-dashboard:${SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION}@${SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE_DIGEST}`;

// `--admin=source` unpacks the dashboard from this repo at the same tag the image
// above is built from, so both admin modes scaffold the same dashboard. It downloads
// by SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT. Override the ref with
// SEAMLESS_ADMIN_DASHBOARD_REF (used as given, unpinned), or point at a local
// checkout with SEAMLESS_ADMIN_DASHBOARD_DIR.
export const SEAMLESS_AUTH_ADMIN_DASHBOARD_REPO =
  "fells-code/seamless-auth-admin-dashboard";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_REF = SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION;

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT = "cd4467504fc3e2e4dbb09c13b6f3375101842512";

// The starter templates monorepo the CLI scaffolds from. The tag names the release;
// the download is pinned to the commit it resolved to when bumped. Override with
// SEAMLESS_TEMPLATES_REF (used as given, unpinned), or point at a local checkout with
// SEAMLESS_TEMPLATES_DIR.
export const SEAMLESS_TEMPLATES_REPO = "fells-code/seamless-templates";

export const SEAMLESS_TEMPLATES_REF = "v0.21.0";

export const SEAMLESS_TEMPLATES_COMMIT = "abed6be0b9f601003d64357978e95d0788fb779c";
