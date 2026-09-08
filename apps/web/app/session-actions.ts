"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

async function revoke(path: string): Promise<void> {
  const jar = await cookies();
  let response: Response;
  try {
    response = await fetch(`${process.env.API_ORIGIN ?? "http://localhost:4000"}${path}`, {
      method: "POST",
      headers: { cookie: jar.toString(), "x-devmemoir-csrf": jar.get("devmemoir_csrf")?.value ?? "" },
      cache: "no-store",
    });
  } catch {
    redirect("/connect?error=session_revocation_failed");
  }
  if (!response.ok && response.status !== 401) redirect("/connect?error=session_revocation_failed");
  // Expire with the original attributes: browsers reject a __Host- cookie
  // deletion that omits Secure, even when its Max-Age is zero.
  jar.set("__Host-devmemoir_session", "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  jar.set("devmemoir_csrf", "", { httpOnly: false, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  redirect("/");
}

export async function logout(): Promise<void> { return revoke("/auth/logout"); }
export async function revokeAllSessions(): Promise<void> { return revoke("/auth/sessions/revoke"); }
