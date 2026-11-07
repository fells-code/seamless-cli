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

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION = "v0.13.0";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE_DIGEST =
  "sha256:c6e4490d15e77f3c86d900f4a08c6ddf7f5f1da06613f6467ae325bf06a7ce97";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE = `ghcr.io/fells-code/seamless-auth-admin-dashboard:${SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION}@${SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE_DIGEST}`;

// `--admin=source` unpacks the dashboard from this repo at the same tag the image
// above is built from, so both admin modes scaffold the same dashboard. It downloads
// by SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT. Override the ref with
// SEAMLESS_ADMIN_DASHBOARD_REF (used as given, unpinned), or point at a local
// checkout with SEAMLESS_ADMIN_DASHBOARD_DIR.
export const SEAMLESS_AUTH_ADMIN_DASHBOARD_REPO =
  "fells-code/seamless-auth-admin-dashboard";

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_REF = SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION;

export const SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT = "a331a4a879a689892491ef2a62a735b295b8852b";

// The starter templates monorepo the CLI scaffolds from. The tag names the release;
// the download is pinned to the commit it resolved to when bumped. Override with
// SEAMLESS_TEMPLATES_REF (used as given, unpinned), or point at a local checkout with
// SEAMLESS_TEMPLATES_DIR.
export const SEAMLESS_TEMPLATES_REPO = "fells-code/seamless-templates";

export const SEAMLESS_TEMPLATES_REF = "v0.21.2";

export const SEAMLESS_TEMPLATES_COMMIT = "c8eef215133032ddf58f694e484a24b591405562";
