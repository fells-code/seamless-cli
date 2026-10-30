import { describe, expect, it } from "vitest";
import {
  POSTGRES_IMAGE,
  SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT,
  SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE,
  SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE_DIGEST,
  SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION,
  SEAMLESS_AUTH_API_COMMIT,
  SEAMLESS_AUTH_API_IMAGE,
  SEAMLESS_AUTH_API_IMAGE_DIGEST,
  SEAMLESS_AUTH_API_VERSION,
  SEAMLESS_TEMPLATES_COMMIT,
  SEAMLESS_TEMPLATES_REF,
  SEAMLESS_TEMPLATES_REPO,
} from "./images.js";

describe("image and version constants", () => {
  it("pins the postgres image", () => {
    expect(POSTGRES_IMAGE).toBe("postgres:18");
  });

  it("builds the auth API image from its version and digest", () => {
    expect(SEAMLESS_AUTH_API_IMAGE).toBe(
      `ghcr.io/fells-code/seamless-auth-api:${SEAMLESS_AUTH_API_VERSION}@${SEAMLESS_AUTH_API_IMAGE_DIGEST}`,
    );
  });

  it("builds the admin dashboard image from its version and digest", () => {
    expect(SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE).toBe(
      `ghcr.io/fells-code/seamless-auth-admin-dashboard:${SEAMLESS_AUTH_ADMIN_DASHBOARD_VERSION}@${SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE_DIGEST}`,
    );
  });

  // `npm run check:pins` checks the values against their tags; this checks the shape,
  // so a truncated or abbreviated pin fails without the network.
  it("pins full commit SHAs and sha256 image digests", () => {
    for (const commit of [
      SEAMLESS_AUTH_API_COMMIT,
      SEAMLESS_AUTH_ADMIN_DASHBOARD_COMMIT,
      SEAMLESS_TEMPLATES_COMMIT,
    ]) {
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
    }
    for (const digest of [
      SEAMLESS_AUTH_API_IMAGE_DIGEST,
      SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE_DIGEST,
    ]) {
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("defines the templates monorepo location", () => {
    expect(SEAMLESS_TEMPLATES_REPO).toBe("fells-code/seamless-templates");
    expect(SEAMLESS_TEMPLATES_REF).toBeTruthy();
  });
});
