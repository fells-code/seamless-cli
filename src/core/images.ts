// Baked into each scaffold's own docker-compose.yml at generation time, so a
// bump here reaches new projects only. An existing project keeps the major it was
// scaffolded with, and never has its data directory pulled out from under it.
export const POSTGRES_IMAGE = "postgres:18";

export const SEAMLESS_AUTH_API_VERSION = "v0.13.1";

export const SEAMLESS_AUTH_API_IMAGE = `ghcr.io/fells-code/seamless-auth-api:${SEAMLESS_AUTH_API_VERSION}`;

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION = "v0.7.0";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE = `ghcr.io/fells-code/seamless-auth-admin-dashboard:${SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION}`;

// `--admin=source` unpacks the dashboard from this repo at the same tag the image
// above is built from, so both admin modes scaffold the same dashboard. Override
// the ref with SEAMLESS_ADMIN_DASHBOARD_REF, or point at a local checkout with
// SEAMLESS_ADMIN_DASHBOARD_DIR.
export const SEAMLESS_AUTH_ADMIN_DASHBOARD_REPO =
  "fells-code/seamless-auth-admin-dashboard";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_REF = SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION;

// The starter templates monorepo the CLI scaffolds from. Pinned to a tag so a given
// CLI version always produces the same project. Override the ref with
// SEAMLESS_TEMPLATES_REF, or point at a local checkout with SEAMLESS_TEMPLATES_DIR.
export const SEAMLESS_TEMPLATES_REPO = "fells-code/seamless-templates";

export const SEAMLESS_TEMPLATES_REF = "v0.14.0";
