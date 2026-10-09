// Baked into each scaffold's own docker-compose.yml at generation time, so a
// bump here reaches new projects only. An existing project keeps the major it was
// scaffolded with, and never has its data directory pulled out from under it.
export const POSTGRES_IMAGE = "postgres:18";

export const SEAMLESS_AUTH_API_VERSION = "v0.18.0";

export const SEAMLESS_AUTH_API_IMAGE = `ghcr.io/fells-code/seamless-auth-api:${SEAMLESS_AUTH_API_VERSION}`;

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION = "v0.9.1";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE = `ghcr.io/fells-code/seamless-auth-admin-dashboard:${SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION}`;

// `--admin=source` unpacks the dashboard from this repo at the same tag the image
// above is built from, so both admin modes scaffold the same dashboard. Override
// the ref with SEAMLESS_ADMIN_DASHBOARD_REF, or point at a local checkout with
// SEAMLESS_ADMIN_DASHBOARD_DIR.
export const SEAMLESS_AUTH_ADMIN_DASHBOARD_REPO =
  "fells-code/seamless-auth-admin-dashboard";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_REF = SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION;

// The starter templates monorepo the CLI scaffolds from. The tag names the release;
// the download is pinned to the commit it resolved to when bumped, because a tag can
// be moved and the extracted code is then installed and built on the developer's
// machine. Bump both together: `npm run check:templates-pin` (run in CI) fails when
// they disagree. Override with SEAMLESS_TEMPLATES_REF (used as given, unpinned), or
// point at a local checkout with SEAMLESS_TEMPLATES_DIR.
export const SEAMLESS_TEMPLATES_REPO = "fells-code/seamless-templates";

export const SEAMLESS_TEMPLATES_REF = "v0.18.0";

export const SEAMLESS_TEMPLATES_COMMIT = "b2d2b30079e84223a148297b54a559e82f6e0fdc";
