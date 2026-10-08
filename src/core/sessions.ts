import { SessionListResponseSchema, type Session } from "@seamless-auth/types";
import type { AuthClient } from "./authClient.js";

export async function listSessions(client: AuthClient): Promise<Session[]> {
  const res = await client.get<unknown>("/sessions");
  if (!res.ok) {
    throw new Error(`Could not list sessions (${res.status}).`);
  }

  // Parsed rather than probed field by field, so a row the instance sends malformed
  // fails the command instead of vanishing from the list.
  const parsed = SessionListResponseSchema.safeParse(res.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `The instance returned a session list this CLI cannot read (${issue.path.join(".") || "response"}: ${issue.message}).`,
    );
  }
  return parsed.data.sessions;
}

export interface RevokeResult {
  ok: boolean;
  status: number;
}

export async function revokeSessionById(
  client: AuthClient,
  id: string,
): Promise<RevokeResult> {
  const res = await client.request(`/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return { ok: res.ok, status: res.status };
}

export async function revokeAllSessions(
  client: AuthClient,
): Promise<RevokeResult> {
  const res = await client.request("/sessions", { method: "DELETE" });
  return { ok: res.ok, status: res.status };
}
