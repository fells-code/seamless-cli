import net from "net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describePortConflict,
  findPortConflicts,
  isListening,
  stackPorts,
} from "./ports.js";

const servers: net.Server[] = [];

function listen(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    servers.push(server);
    server.once("error", reject);
    server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port));
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))),
  );
});

describe("stackPorts", () => {
  it("lists web, api, auth and db for the default stack", () => {
    expect(stackPorts({ adminMode: "api" })).toEqual([
      { port: 5173, service: "web" },
      { port: 3000, service: "api" },
      { port: 5312, service: "auth" },
      { port: 5432, service: "db" },
    ]);
  });

  it("drops the api for a full-stack web app and adds the admin container's port", () => {
    expect(stackPorts({ fullStack: true, adminMode: "image" })).toEqual([
      { port: 5173, service: "web" },
      { port: 5312, service: "auth" },
      { port: 5432, service: "db" },
      { port: 5174, service: "admin" },
    ]);
  });
});

describe("isListening", () => {
  it("is true for a port something listens on and false once it stops", async () => {
    const port = await listen("127.0.0.1");
    expect(await isListening("127.0.0.1", port)).toBe(true);

    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect(await isListening("127.0.0.1", port)).toBe(false);
  });
});

describe("findPortConflicts", () => {
  it("checks both loopbacks before the stack runs and reports where each port is taken", async () => {
    const probe = vi.fn(
      async (host: string, port: number) =>
        (port === 5173 && host === "::1") || (port === 5432 && host === "127.0.0.1"),
    );

    const conflicts = await findPortConflicts(stackPorts({ adminMode: "api" }), {
      includeIpv4: true,
      probe,
    });

    expect(conflicts).toEqual([
      { port: 5173, service: "web", hosts: ["::1"] },
      { port: 5432, service: "db", hosts: ["127.0.0.1"] },
    ]);
    expect(probe).toHaveBeenCalledTimes(8);
  });

  // The running stack holds 127.0.0.1 itself, so only [::1] can show a stranger.
  it("checks only [::1] while the stack runs", async () => {
    const probe = vi.fn(async () => true);

    await findPortConflicts([{ port: 5173, service: "web" }], {
      includeIpv4: false,
      probe,
    });

    expect(probe.mock.calls).toEqual([["::1", 5173]]);
  });
});

describe("describePortConflict", () => {
  it("says a browser on localhost reaches the other program when it holds [::1]", () => {
    const [what, remedy] = describePortConflict({
      port: 5173,
      service: "web",
      hosts: ["::1"],
    });
    expect(what).toBe(
      "Port 5173 (web) is held on [::1] by another program. Browsers try [::1] first, so http://localhost:5173 opens that program instead of this project's web.",
    );
    expect(remedy).toContain("lsof -nP -iTCP:5173 -sTCP:LISTEN");
  });

  it("says docker compose up cannot publish a port taken on 127.0.0.1", () => {
    const [what] = describePortConflict({
      port: 3000,
      service: "api",
      hosts: ["127.0.0.1"],
    });
    expect(what).toContain("docker compose up cannot publish it");
    expect(what).toContain("docker compose down in that project");
  });

  it("describes a database port without a browser", () => {
    const [what] = describePortConflict({ port: 5432, service: "db", hosts: ["::1"] });
    expect(what).toContain("connects to localhost:5432");
    expect(what).not.toContain("Browsers");
  });
});
