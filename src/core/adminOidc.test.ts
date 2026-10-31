import { describe, expect, it } from "vitest";
import type { AuthClient } from "./authClient.js";
import type { ApiResponse } from "./http.js";
import {
  AdminApiError,
  createApplication,
  createResource,
  deleteApplication,
  deleteResource,
  getApplication,
  getResource,
  listApplicationResources,
  listApplications,
  listResources,
  rotateApplicationSecret,
  setApplicationKeys,
  setApplicationResources,
  updateApplication,
  updateResource,
} from "./admin.js";
import { apiApplication, apiResource, RESOURCE_ID } from "./admin.fixtures.js";
import { StepUpError } from "./stepUp.js";

function response<T>(status: number, data: T | null): ApiResponse<T> {
  return { ok: status >= 200 && status < 300, status, data, headers: new Headers() };
}

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

function fakeClient(
  handler: (rec: Recorded) => ApiResponse<unknown>,
): { client: AuthClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const record = (method: string, path: string, init?: RequestInit) => {
    const rec: Recorded = {
      method,
      path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(rec);
    return handler(rec);
  };
  return {
    calls,
    client: {
      profile: { name: "default", instanceUrl: "https://auth.example.com" },
      get: async (path) => record("GET", path) as never,
      post: async (path) => record("POST", path) as never,
      request: async (path, init) =>
        record((init?.method ?? "GET").toUpperCase(), path, init) as never,
    },
  };
}

const always = (status: number, data: unknown) => fakeClient(() => response(status, data));

const link = {
  resourceId: RESOURCE_ID,
  identifier: "https://orders.example.com",
  name: "Orders",
  scopes: ["orders:read"],
};

describe("OpenID Provider applications", () => {
  it("lists applications, keeping fields this CLI does not know", async () => {
    const { client, calls } = always(200, {
      applications: [apiApplication()],
      nextCursor: "later",
    });
    expect(await listApplications(client)).toEqual([apiApplication()]);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/admin/applications" });
  });

  it("encodes the id in every application path", async () => {
    const app = apiApplication({ id: "a/b" });
    const { client, calls } = fakeClient(({ path }) =>
      path.endsWith("/secret")
        ? response(200, { application: app, clientSecret: "s" })
        : path.endsWith("/resources")
          ? response(200, { resources: [link] })
          : response(200, { application: app, message: "ok" }),
    );

    await getApplication(client, "a/b");
    await updateApplication(client, "a/b", { name: "x" });
    await deleteApplication(client, "a/b");
    expect(await rotateApplicationSecret(client, "a/b")).toEqual({
      application: app,
      clientSecret: "s",
    });
    await setApplicationKeys(client, "a/b", { jwksUri: "https://k.example.com" });
    expect(await listApplicationResources(client, "a/b")).toEqual([link]);
    expect(
      await setApplicationResources(client, "a/b", [
        { resourceId: RESOURCE_ID, scopes: ["orders:read"] },
      ]),
    ).toEqual([link]);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /admin/applications/a%2Fb",
      "PATCH /admin/applications/a%2Fb",
      "DELETE /admin/applications/a%2Fb",
      "POST /admin/applications/a%2Fb/secret",
      "PUT /admin/applications/a%2Fb/keys",
      "GET /admin/applications/a%2Fb/resources",
      "PUT /admin/applications/a%2Fb/resources",
    ]);
    expect(calls[1].body).toEqual({ name: "x" });
    expect(calls[6].body).toEqual({
      resources: [{ resourceId: RESOURCE_ID, scopes: ["orders:read"] }],
    });
  });

  it("returns a created application with its one-time secret", async () => {
    const { client, calls } = always(201, {
      application: apiApplication(),
      clientSecret: "once",
    });
    const body = {
      name: "Docs",
      clientType: "confidential" as const,
      firstParty: false,
      redirectUris: [],
      postLogoutRedirectUris: [],
      grantTypes: ["client_credentials" as const],
      deviceFlowEnabled: false,
      noticesEnabled: false,
    };
    expect(await createApplication(client, body)).toEqual({
      application: apiApplication(),
      clientSecret: "once",
    });
    expect(calls[0]).toMatchObject({ method: "POST", body });
  });

  it.each([
    ["get", (c: AuthClient) => getApplication(c, "x")],
    ["update", (c: AuthClient) => updateApplication(c, "x", {})],
    ["delete", (c: AuthClient) => deleteApplication(c, "x")],
    ["rotate", (c: AuthClient) => rotateApplicationSecret(c, "x")],
    ["keys", (c: AuthClient) => setApplicationKeys(c, "x", { jwksUri: "https://k" })],
    ["list resources", (c: AuthClient) => listApplicationResources(c, "x")],
    ["set resources", (c: AuthClient) => setApplicationResources(c, "x", [])],
  ])("names the missing application on a 404 from %s", async (_name, run) => {
    const { client } = always(404, { error: "Application not found" });
    await expect(run(client)).rejects.toThrow("No application found with id x");
  });

  it.each([
    ["list", (c: AuthClient) => listApplications(c), "Could not list applications"],
    ["get", (c: AuthClient) => getApplication(c, "x"), "Could not load application"],
    [
      "create",
      (c: AuthClient) =>
        createApplication(c, {
          name: "x",
          clientType: "public",
          firstParty: false,
          redirectUris: [],
          postLogoutRedirectUris: [],
          grantTypes: [],
          deviceFlowEnabled: false,
          noticesEnabled: false,
        }),
      "Could not create application",
    ],
    ["update", (c: AuthClient) => updateApplication(c, "x", {}), "Could not update application"],
    ["delete", (c: AuthClient) => deleteApplication(c, "x"), "Could not delete application"],
    ["rotate", (c: AuthClient) => rotateApplicationSecret(c, "x"), "Could not issue a secret"],
    [
      "keys",
      (c: AuthClient) => setApplicationKeys(c, "x", { jwksUri: "https://k" }),
      "Could not register keys",
    ],
    [
      "list resources",
      (c: AuthClient) => listApplicationResources(c, "x"),
      "Could not list the application's resources",
    ],
    [
      "set resources",
      (c: AuthClient) => setApplicationResources(c, "x", []),
      "Could not set the application's resources",
    ],
  ])("reports the API's reason when %s fails", async (_name, run, summary) => {
    const { client } = always(400, { error: "Keys are only used by private_key_jwt applications." });
    const error = await run(client).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as Error).message).toBe(
      `${summary} (400: Keys are only used by private_key_jwt applications).`,
    );
  });

  it("raises a step-up error for a write refused for step-up", async () => {
    const { client } = always(403, { error: "step_up_required" });
    await expect(deleteApplication(client, "x")).rejects.toBeInstanceOf(StepUpError);
  });

  it("refuses a response it cannot read", async () => {
    const { client } = always(200, { applications: [{ id: 1 }] });
    await expect(listApplications(client)).rejects.toThrow(
      /The instance returned an application list this CLI cannot read/,
    );
  });
});

describe("OpenID Provider resources", () => {
  it("lists, reads, creates, updates and deletes resources", async () => {
    const resource = apiResource();
    const { client, calls } = fakeClient(({ path, method }) =>
      path === "/admin/resources" && method === "GET"
        ? response(200, { resources: [resource] })
        : response(200, { resource, message: "ok" }),
    );

    expect(await listResources(client)).toEqual([resource]);
    expect(await getResource(client, RESOURCE_ID)).toEqual(resource);
    expect(
      await createResource(client, {
        identifier: resource.identifier,
        name: "Orders",
        scopes: [],
      }),
    ).toEqual(resource);
    expect(await updateResource(client, RESOURCE_ID, { scopes: ["a"] })).toEqual(resource);
    await deleteResource(client, RESOURCE_ID);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /admin/resources",
      `GET /admin/resources/${RESOURCE_ID}`,
      "POST /admin/resources",
      `PATCH /admin/resources/${RESOURCE_ID}`,
      `DELETE /admin/resources/${RESOURCE_ID}`,
    ]);
  });

  it("names the identifier a duplicate resource clashes with", async () => {
    const { client } = always(409, { error: "A resource with that identifier already exists" });
    await expect(
      createResource(client, { identifier: "urn:x", name: "X", scopes: [] }),
    ).rejects.toThrow("A resource with identifier urn:x already exists (409");
  });

  it.each([
    ["get", (c: AuthClient) => getResource(c, "r")],
    ["update", (c: AuthClient) => updateResource(c, "r", {})],
    ["delete", (c: AuthClient) => deleteResource(c, "r")],
  ])("names the missing resource on a 404 from %s", async (_name, run) => {
    const { client } = always(404, { error: "Resource not found" });
    await expect(run(client)).rejects.toThrow("No resource found with id r");
  });

  it.each([
    ["list", (c: AuthClient) => listResources(c), "Could not list resources"],
    ["get", (c: AuthClient) => getResource(c, "r"), "Could not load resource"],
    [
      "create",
      (c: AuthClient) => createResource(c, { identifier: "urn:x", name: "X", scopes: [] }),
      "Could not create resource",
    ],
    ["update", (c: AuthClient) => updateResource(c, "r", {}), "Could not update resource"],
    ["delete", (c: AuthClient) => deleteResource(c, "r"), "Could not delete resource"],
  ])("reports the API's reason when %s fails", async (_name, run, summary) => {
    const { client } = always(500, null);
    await expect(run(client)).rejects.toThrow(`${summary} (500).`);
  });
});
