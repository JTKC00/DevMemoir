"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

const apiOrigin = () => process.env.API_ORIGIN ?? "http://localhost:4000";

async function forwardedHeaders(): Promise<Record<string, string>> {
  const requestHeaders = await headers();
  const csrf = (await cookies()).get("devmemoir_csrf")?.value;
  return { cookie: requestHeaders.get("cookie") ?? "", ...(csrf ? { "x-devmemoir-csrf": csrf } : {}) };
}

async function recover(path: string, action: string): Promise<void> {
  const response = await fetch(`${apiOrigin()}${path}`, { method: "POST", headers: await forwardedHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { result?: string };
  redirect(`/ops?action=${encodeURIComponent(action)}&result=${encodeURIComponent(body.result ?? "failed")}`);
}

export async function retryRepositoryReconciliation(formData: FormData): Promise<void> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  if (!repositoryId) redirect("/ops?action=reconciliation&result=not_eligible");
  await recover(`/api/ops/repositories/${encodeURIComponent(repositoryId)}/reconcile`, "reconciliation");
}

export async function retryDeliveryAudit(): Promise<void> { await recover("/api/ops/delivery-audit/retry", "delivery_audit"); }
export async function resumeDeliveryRepairs(): Promise<void> { await recover("/api/ops/delivery-repairs/resume", "delivery_repairs"); }
