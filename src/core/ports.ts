import net from "net";

import type { AdminMode } from "../generators/docker/docker.js";

export interface StackPort {
  port: number;
  service: string;
}

// The generated compose file publishes every port on 127.0.0.1 only.
export const IPV4_LOOPBACK = "127.0.0.1";
export const IPV6_LOOPBACK = "::1";

export type Loopback = typeof IPV4_LOOPBACK | typeof IPV6_LOOPBACK;

export interface PortConflict extends StackPort {
  hosts: Loopback[];
}

/** The host ports a scaffolded local stack publishes. */
export function stackPorts(options: {
  fullStack?: boolean;
  adminMode?: AdminMode | string;
}): StackPort[] {
  const ports: StackPort[] = [{ port: 5173, service: "web" }];
  if (!options.fullStack) ports.push({ port: 3000, service: "api" });
  ports.push({ port: 5312, service: "auth" }, { port: 5432, service: "db" });
  if (options.adminMode === "image" || options.adminMode === "source") {
    ports.push({ port: 5174, service: "admin" });
  }
  return ports;
}

/** Whether something accepts a TCP connection on host:port. */
export function isListening(
  host: string,
  port: number,
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    // Refused, or no IPv6 loopback on this machine: either way nothing is there.
    socket.once("error", () => done(false));
  });
}

/**
 * Finds the stack's ports that some other program already holds.
 *
 * [::1] is always checked, because the stack never publishes there: a listener on
 * it is another program, and browsers try ::1 first for localhost, so it silently
 * wins (a Vite dev server on its default 5173 is the usual case). 127.0.0.1 is
 * checked only before the stack runs, when anything on it would make
 * `docker compose up` fail to publish the port.
 */
export async function findPortConflicts(
  ports: StackPort[],
  options: { includeIpv4: boolean; probe?: typeof isListening },
): Promise<PortConflict[]> {
  const probe = options.probe ?? isListening;
  const hosts: Loopback[] = options.includeIpv4
    ? [IPV4_LOOPBACK, IPV6_LOOPBACK]
    : [IPV6_LOOPBACK];

  const results = await Promise.all(
    ports.map(async (entry) => {
      const taken: Loopback[] = [];
      for (const host of hosts) {
        if (await probe(host, entry.port)) taken.push(host);
      }
      return { ...entry, hosts: taken };
    }),
  );
  return results.filter((entry) => entry.hosts.length > 0);
}

/** One line saying what the conflict breaks, then how to find the program. */
export function describePortConflict(conflict: PortConflict): string[] {
  const { port, service } = conflict;
  const what = conflict.hosts.includes(IPV6_LOOPBACK)
    ? service === "db"
      ? `Port ${port} (${service}) is held on [::1] by another program, so an app on this machine that connects to localhost:${port} reaches that program instead of this stack's database.`
      : `Port ${port} (${service}) is held on [::1] by another program. Browsers try [::1] first, so http://localhost:${port} opens that program instead of this project's ${service}.`
    : `Port ${port} (${service}) is already in use, so docker compose up cannot publish it. If it is another Seamless project, run docker compose down in that project.`;
  return [
    what,
    `Stop that program first. On macOS or Linux, lsof -nP -iTCP:${port} -sTCP:LISTEN names it.`,
  ];
}
