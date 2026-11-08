// Baked into each scaffold's own docker-compose.yml at generation time, so a
// bump here reaches new projects only. An existing project keeps the major it was
// scaffolded with, and never has its data directory pulled out from under it.
export const POSTGRES_IMAGE = "postgres:18";

// Each tag below is paired with the commit (and image digest) it resolved to when
// bumped, because a tag can be moved and what it names is then built and run on the
// developer's machine. Bump them together: `npm run check:templates-pin` (run in CI)
// checks every pin in this file against its tag and fails when one disagrees.
export const SEAMLESS_AUTH_API_VERSION = "v0.23.0";

export const SEAMLESS_AUTH_API_COMMIT = "afd4495c2af3f2be709d4f8802124870382a7716";

export const SEAMLESS_AUTH_API_IMAGE_DIGEST =
  "sha256:c32b2e84a32b2b5a2fd69112453090f62a89226e81f86cf2d06d49ec9fafc2c9";

export const SEAMLESS_AUTH_API_IMAGE = `ghcr.io/fells-code/seamless-auth-api:${SEAMLESS_AUTH_API_VERSION}@${SEAMLESS_AUTH_API_IMAGE_DIGEST}`;

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION = "v0.14.0";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE_DIGEST =
  "sha256:78baccc3a240c7a9474e6b9a8bf48e65281e2fdd6fcff835043a379437427c90";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE = `ghcr.io/fells-code/seamless-auth-admin-dashboard:${SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION}@${SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE_DIGEST}`;

// `--admin=source` unpacks the dashboard from this repo at the same tag the image
// above is built from, so both admin modes scaffold the same dashboard. It downloads
// by SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT. Override the ref with
// SEAMLESS_ADMIN_DASHBOARD_REF (used as given, unpinned), or point at a local
// checkout with SEAMLESS_ADMIN_DASHBOARD_DIR.
export const SEAMLESS_AUTH_ADMIN_DASHBOARD_REPO =
  "fells-code/seamless-auth-admin-dashboard";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_REF = SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION;

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT = "df2a8b78f7a8eb7adeec67e900d89cbd1937c6dd";

// The starter templates monorepo the CLI scaffolds from. The tag names the release;
// the download is pinned to the commit it resolved to when bumped. Override with
// SEAMLESS_TEMPLATES_REF (used as given, unpinned), or point at a local checkout with
// SEAMLESS_TEMPLATES_DIR.
export const SEAMLESS_TEMPLATES_REPO = "fells-code/seamless-templates";

export const SEAMLESS_TEMPLATES_REF = "v0.22.0";

export const SEAMLESS_TEMPLATES_COMMIT = "722881655f92c06b815e0591d8633d77e6b7f70f";
