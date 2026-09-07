"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

const apiOrigin = () => process.env.API_ORIGIN ?? "http://localhost:4000";

async function forwardedHeaders(): Promise<Record<string, string>> {
  const requestHeaders = await headers();
  const cookieHeader = requestHeaders.get("cookie") ?? "";
  const csrf = (await cookies()).get("devmemoir_csrf")?.value;
  return { cookie: cookieHeader, ...(csrf ? { "x-devmemoir-csrf": csrf } : {}) };
}

export async function startInstallation(): Promise<void> {
  const response = await fetch(`${apiOrigin()}/connect/start`, { method: "POST", headers: await forwardedHeaders(), cache: "no-store" });
  if (!response.ok) redirect("/connect?error=installation_start_failed");
  const result = await response.json() as { installationUrl?: string };
  if (!result.installationUrl) redirect("/connect?error=installation_start_failed");
  redirect(result.installationUrl);
}

export async function claimInstallation(formData: FormData): Promise<void> {
  const installationId = Number(formData.get("installation_id"));
  const response = await fetch(`${apiOrigin()}/connect/claim`, {
    method: "POST",
    headers: { ...await forwardedHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ installation_id: installationId }),
    cache: "no-store",
  });
  if (!response.ok) redirect("/connect?error=installation_claim_failed");
  redirect("/connect?connected=1");
}

export async function refreshInventory(): Promise<void> {
  const response = await fetch(`${apiOrigin()}/connect/repositories/refresh`, { method: "POST", headers: await forwardedHeaders(), cache: "no-store" });
  if (!response.ok) redirect("/connect?error=inventory_refresh_failed");
  redirect("/connect?refreshed=1");
}

export async function disconnectInstallation(): Promise<void> {
  const response = await fetch(`${apiOrigin()}/connect/disconnect`, { method: "POST", headers: await forwardedHeaders(), cache: "no-store" });
  if (!response.ok) redirect("/connect?error=disconnect_failed");
  redirect("/connect?disconnected=1");
}

export async function deleteAccount(formData: FormData): Promise<void> {
  if (formData.get("confirm") !== "delete_account") redirect("/connect?error=deletion_confirmation_required");
  let response: Response;
  try {
    response = await fetch(`${apiOrigin()}/account/delete`, {
      method: "POST", headers: { ...await forwardedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ confirm: "delete_account" }), cache: "no-store",
    });
  } catch { redirect("/connect?error=account_deletion_failed"); }
  if (response.status !== 202) redirect("/connect?error=account_deletion_failed");
  const jar = await cookies();
  jar.set("__Host-devmemoir_session", "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  jar.set("devmemoir_csrf", "", { httpOnly: false, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  redirect("/account/deletion-requested");
}

export async function connectRepository(formData: FormData): Promise<void> {
  const fullName = String(formData.get("fullName") ?? "");
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const [owner, repo] = fullName.split("/", 2);
  if (!repositoryId && (!owner || !repo)) redirect("/connect?error=repository_required");
  const response = await fetch(`${apiOrigin()}/connect/repository`, {
    method: "POST",
    headers: { ...await forwardedHeaders(), "content-type": "application/json" },
    body: JSON.stringify(repositoryId ? { repositoryId } : { owner, repo }),
    cache: "no-store",
  });
  if (response.status === 409) redirect("/connect?error=one_repository_only");
  if (!response.ok) redirect("/connect?error=repository_connect_failed");
  redirect("/");
}

export async function unselectRepository(formData: FormData): Promise<void> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const response = await fetch(`${apiOrigin()}/connect/repository/unselect`, {
    method: "POST",
    headers: { ...await forwardedHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ repositoryId }),
    cache: "no-store",
  });
  if (!response.ok) redirect("/connect?error=repository_unselect_failed");
  redirect("/connect?unselected=1");
}

export async function resumeBackfill(formData: FormData): Promise<void> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const response = await fetch(`${apiOrigin()}/connect/repository/backfill`, {
    method: "POST",
    headers: { ...await forwardedHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ repositoryId }),
    cache: "no-store",
  });
  if (!response.ok) redirect("/connect?error=backfill_resume_failed");
  redirect("/connect?backfill=queued");
}
