import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code");
  const returnPath = request.nextUrl.searchParams.get("returnPath");
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const failure = () => NextResponse.redirect(new URL("/?error=login_failed", webOrigin), { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  if (!code || !returnPath?.startsWith("/") || returnPath.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(returnPath)) return failure();
  try {
    const response = await fetch(`${process.env.API_ORIGIN ?? "http://localhost:4000"}/auth/handoff/exchange`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }), cache: "no-store",
    });
    if (!response.ok) return failure();
    const session = await response.json() as { sessionToken?: unknown; csrfToken?: unknown };
    if (typeof session.sessionToken !== "string" || !session.sessionToken || typeof session.csrfToken !== "string" || !session.csrfToken) return failure();
    const redirect = NextResponse.redirect(new URL(returnPath, webOrigin), { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    redirect.cookies.set("__Host-devmemoir_session", session.sessionToken, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
    redirect.cookies.set("devmemoir_csrf", session.csrfToken, { httpOnly: false, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
    return redirect;
  } catch {
    return failure();
  }
}
