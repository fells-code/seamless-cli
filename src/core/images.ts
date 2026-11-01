// Baked into each scaffold's own docker-compose.yml at generation time, so a
// bump here reaches new projects only. An existing project keeps the major it was
// scaffolded with, and never has its data directory pulled out from under it.
export const POSTGRES_IMAGE = "postgres:18";

// Each tag below is paired with the commit (and image digest) it resolved to when
// bumped, because a tag can be moved and what it names is then built and run on the
// developer's machine. Bump them together: `npm run check:templates-pin` (run in CI)
// checks every pin in this file against its tag and fails when one disagrees.
export const SEAMLESS_AUTH_API_VERSION = "v0.21.0";

export const SEAMLESS_AUTH_API_COMMIT = "930d4dc812df051b948a5bd138871f625900f1eb";

export const SEAMLESS_AUTH_API_IMAGE_DIGEST =
  "sha256:5765de03b10d348da047e50407fcb7109f2a6dae64ddde86a1a6d0b92575dfa1";

export const SEAMLESS_AUTH_API_IMAGE = `ghcr.io/fells-code/seamless-auth-api:${SEAMLESS_AUTH_API_VERSION}@${SEAMLESS_AUTH_API_IMAGE_DIGEST}`;

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION = "v0.12.0";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE_DIGEST =
  "sha256:6c82f2053687b26113b889c08b9b42e785580bb22e5502c6eb03c181378841aa";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE = `ghcr.io/fells-code/seamless-auth-admin-dashboard:${SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION}@${SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE_DIGEST}`;

// `--admin=source` unpacks the dashboard from this repo at the same tag the image
// above is built from, so both admin modes scaffold the same dashboard. It downloads
// by SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT. Override the ref with
// SEAMLESS_ADMIN_DASHBOARD_REF (used as given, unpinned), or point at a local
// checkout with SEAMLESS_ADMIN_DASHBOARD_DIR.
export const SEAMLESS_AUTH_ADMIN_DASHBOARD_REPO =
  "fells-code/seamless-auth-admin-dashboard";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_REF = SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION;

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT = "c3020d2f24ab34c4657e0da06da23a0f4471a7cf";

// The starter templates monorepo the CLI scaffolds from. The tag names the release;
// the download is pinned to the commit it resolved to when bumped. Override with
// SEAMLESS_TEMPLATES_REF (used as given, unpinned), or point at a local checkout with
// SEAMLESS_TEMPLATES_DIR.
export const SEAMLESS_TEMPLATES_REPO = "fells-code/seamless-templates";

export const SEAMLESS_TEMPLATES_REF = "v0.21.1";

export const SEAMLESS_TEMPLATES_COMMIT = "501479f260225c56122b2bc1dfb7c1304efed08f";
