import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function HandoffPage({ searchParams }: { searchParams: Promise<{ code?: string; returnPath?: string }> }) {
  const params = await searchParams;
  if (!params.code || !params.returnPath?.startsWith("/") || params.returnPath.startsWith("//") || params.returnPath.includes("\\")) redirect("/");
  const response = await fetch(`${process.env.API_ORIGIN ?? "http://localhost:4000"}/auth/handoff/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: params.code }), cache: "no-store" });
  if (!response.ok) redirect("/");
  const session = await response.json() as { sessionToken: string; csrfToken: string };
  const cookieStore = await cookies();
  cookieStore.set("__Host-devmemoir_session", session.sessionToken, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
  cookieStore.set("devmemoir_csrf", session.csrfToken, { httpOnly: false, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
  redirect(params.returnPath);
}
