import { APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

import {
  bearer,
  bearerSignup,
  BEARER_TRANSPORT,
  cookieSignup,
  currentUserId,
} from "../lib/conformanceFlows";
import { OWNER_EMAIL } from "../lib/env";
import { expect, test } from "../lib/fixtures";
import { ownerAccessToken, setUserRoles } from "../lib/flows";
import { requireContract } from "../lib/pendingContracts";
import {
  ensurePermissionModel,
  ORG_ROLE,
  organizationWithMember,
  OVERFLOW_ROLE,
  READER_ROLE,
  removeMember,
  WRITER_ROLE,
} from "../lib/permissionFlows";

// The reference app's permission routes (see CONFORMANCE.md). Permissions travel in the access
// token, so every grant here is followed by a refresh before the guard can see it.
const ANY = "/api/permissions/any";
const ALL = "/api/permissions/all";
const ORG = "/api/permissions/org";

async function refresh(ctx: APIRequestContext) {
  const res = await ctx.post("/auth/refresh");
  expect(res.ok(), `refresh -> ${res.status()}`).toBeTruthy();
}

async function expectRefused(
  ctx: APIRequestContext,
  path: string,
  headers = {},
) {
  const res = await ctx.get(path, { headers });
  expect(res.status(), `GET ${path}`).toBe(403);
  // Names nothing: the required permissions would map out the app's authorization model.
  expect(await res.json()).toEqual({ error: "insufficient_permission" });
}

async function expectAllowed(
  ctx: APIRequestContext,
  path: string,
  userId: string,
  headers = {},
) {
  const res = await ctx.get(path, { headers });
  expect(res.status(), `GET ${path}`).toBe(200);
  expect((await res.json()).id).toBe(userId);
}

function claimsOf(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

test.describe("permission guards (adapter)", () => {
  let admin: string;

  test.beforeEach(async ({ actor }) => {
    requireContract("permission-guards");
    admin = await ownerAccessToken(actor.ctx, OWNER_EMAIL);
    await ensurePermissionModel(actor.ctx, admin);
  });

  async function signedIn(adapterActor: {
    ctx: APIRequestContext;
    email: string;
  }) {
    await cookieSignup(adapterActor.ctx, adapterActor.email);
    return currentUserId(adapterActor.ctx);
  }

  test("refuses a request with no session with 401", async ({
    adapterActor,
  }) => {
    for (const path of [ANY, ALL, ORG, `${ORG}/${randomUUID()}`]) {
      expect((await adapterActor.ctx.get(path)).status(), `GET ${path}`).toBe(
        401,
      );
    }
  });

  test("refuses a session holding no permission, naming nothing", async ({
    adapterActor,
  }) => {
    await signedIn(adapterActor);

    for (const path of [ANY, ALL, ORG, `${ORG}/${randomUUID()}`]) {
      await expectRefused(adapterActor.ctx, path);
    }
  });

  test("any of: one permission is enough", async ({ actor, adapterActor }) => {
    const userId = await signedIn(adapterActor);
    await setUserRoles(actor.ctx, admin, userId, ["user", READER_ROLE]);
    await refresh(adapterActor.ctx);

    await expectAllowed(adapterActor.ctx, ANY, userId);
  });

  test("all of: every permission is needed", async ({
    actor,
    adapterActor,
  }) => {
    const userId = await signedIn(adapterActor);
    await setUserRoles(actor.ctx, admin, userId, ["user", READER_ROLE]);
    await refresh(adapterActor.ctx);
    await expectRefused(adapterActor.ctx, ALL);

    await setUserRoles(actor.ctx, admin, userId, [
      "user",
      READER_ROLE,
      WRITER_ROLE,
    ]);
    await refresh(adapterActor.ctx);
    await expectAllowed(adapterActor.ctx, ALL, userId);
  });

  test("matching is exact: write does not imply read", async ({
    actor,
    adapterActor,
  }) => {
    const userId = await signedIn(adapterActor);
    await setUserRoles(actor.ctx, admin, userId, ["user", WRITER_ROLE]);
    await refresh(adapterActor.ctx);

    await expectRefused(adapterActor.ctx, ANY);
  });

  test("a grant is gone once the role is", async ({ actor, adapterActor }) => {
    const userId = await signedIn(adapterActor);
    await setUserRoles(actor.ctx, admin, userId, ["user", READER_ROLE]);
    await refresh(adapterActor.ctx);
    await expectAllowed(adapterActor.ctx, ANY, userId);

    await setUserRoles(actor.ctx, admin, userId, ["user"]);
    await refresh(adapterActor.ctx);
    await expectRefused(adapterActor.ctx, ANY);
  });

  test("accepts a bearer token in the same way", async ({
    actor,
    adapterActor,
  }) => {
    const session = await bearerSignup(adapterActor.ctx, adapterActor.email);
    const userId = await currentUserId(adapterActor.ctx, {
      ...BEARER_TRANSPORT,
      ...bearer(session.token),
    });
    await expectRefused(adapterActor.ctx, ANY, bearer(session.token));

    await setUserRoles(actor.ctx, admin, userId, ["user", READER_ROLE]);
    const refreshed = await adapterActor.ctx.post("/auth/refresh", {
      headers: { ...BEARER_TRANSPORT, ...bearer(session.refreshToken) },
    });
    expect(refreshed.ok(), `refresh -> ${refreshed.status()}`).toBeTruthy();
    const { token } = await refreshed.json();

    await expectAllowed(adapterActor.ctx, ANY, userId, bearer(token));
  });

  test.describe("organization scope", () => {
    async function member(
      actor: { ctx: APIRequestContext },
      adapterActor: { ctx: APIRequestContext; email: string },
      roles: string[] = [ORG_ROLE],
    ) {
      const userId = await signedIn(adapterActor);
      const organizationId = await organizationWithMember(
        actor.ctx,
        admin,
        userId,
        roles,
      );
      const switched = await adapterActor.ctx.post(
        `/auth/organizations/${organizationId}/switch`,
      );
      expect(
        switched.ok(),
        `switch -> ${switched.status()} ${await switched.text()}`,
      ).toBeTruthy();
      return { userId, organizationId };
    }

    test("a route bound to the organization passes only for that organization", async ({
      actor,
      adapterActor,
    }) => {
      const { userId, organizationId } = await member(actor, adapterActor);

      await expectAllowed(adapterActor.ctx, ORG, userId);
      await expectAllowed(adapterActor.ctx, `${ORG}/${organizationId}`, userId);
      await expectRefused(adapterActor.ctx, `${ORG}/${randomUUID()}`);
    });

    test("an organization grant counts on a default route", async ({
      actor,
      adapterActor,
    }) => {
      const { userId } = await member(actor, adapterActor);

      await expectAllowed(adapterActor.ctx, ANY, userId);
    });

    test("an instance grant does not count on an organization route", async ({
      actor,
      adapterActor,
    }) => {
      const { userId, organizationId } = await member(actor, adapterActor, [
        "member",
      ]);
      await setUserRoles(actor.ctx, admin, userId, ["user", READER_ROLE]);
      await refresh(adapterActor.ctx);

      await expectAllowed(adapterActor.ctx, ANY, userId);
      await expectRefused(adapterActor.ctx, ORG);
      await expectRefused(adapterActor.ctx, `${ORG}/${organizationId}`);
    });

    test("removal from the organization reaches the guard at the next token", async ({
      actor,
      adapterActor,
    }) => {
      const { userId, organizationId } = await member(actor, adapterActor);
      await expectAllowed(adapterActor.ctx, ORG, userId);

      await removeMember(actor.ctx, admin, organizationId, userId);
      await refresh(adapterActor.ctx);

      await expectRefused(adapterActor.ctx, ORG);
      await expectRefused(adapterActor.ctx, `${ORG}/${organizationId}`);
    });
  });

  test("reads the live set when the token omits its permissions", async ({
    actor,
    adapterActor,
  }) => {
    const session = await bearerSignup(adapterActor.ctx, adapterActor.email);
    const userId = await currentUserId(adapterActor.ctx, {
      ...BEARER_TRANSPORT,
      ...bearer(session.token),
    });
    await setUserRoles(actor.ctx, admin, userId, ["user", OVERFLOW_ROLE]);
    const refreshed = await adapterActor.ctx.post("/auth/refresh", {
      headers: { ...BEARER_TRANSPORT, ...bearer(session.refreshToken) },
    });
    expect(refreshed.ok(), `refresh -> ${refreshed.status()}`).toBeTruthy();
    const { token } = await refreshed.json();

    const claims = claimsOf(token);
    expect(claims.permissions_omitted, "a set over the budget is omitted").toBe(
      true,
    );
    expect(claims.permissions).toBeUndefined();

    // Holds conformance:read through the live read, and not conformance:write.
    await expectAllowed(adapterActor.ctx, ANY, userId, bearer(token));
    await expectRefused(adapterActor.ctx, ALL, bearer(token));
  });
});
