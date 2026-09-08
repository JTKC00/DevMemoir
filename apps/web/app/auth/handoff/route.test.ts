import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("login handoff route", () => {
  function request(returnPath = "/connect") {
    return new NextRequest(`http://localhost:3000/auth/handoff?${new URLSearchParams({ code: "one-time-code", returnPath })}`);
  }

  it("sets secure cookies on a no-store redirect after exchanging the one-time code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ sessionToken: "session", csrfToken: "csrf" })));
    const response = await GET(request());
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/connect");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.cookies.get("__Host-devmemoir_session")).toMatchObject({ value: "session", httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(response.cookies.get("devmemoir_csrf")).toMatchObject({ value: "csrf", secure: true, path: "/" });
  });

  it.each(["https://example.com/", "//example.com/", "/\\example.com/", "/\n/example.com", ""])("rejects an unsafe return path %j before consuming the code", async (path) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(request(path));
    expect(response.headers.get("location")).toBe("http://localhost:3000/?error=login_failed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.cookies.getAll()).toEqual([]);
  });

  it("uses the configured public origin rather than the request Host", async () => {
    vi.stubEnv("WEB_ORIGIN", "https://memoir.example.com");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ sessionToken: "session", csrfToken: "csrf" })));
    expect((await GET(request())).headers.get("location")).toBe("https://memoir.example.com/connect");
  });

  it.each([new Response(null, { status: 400 }), Response.json({}), new Response("not json")])("does not set cookies when exchange fails", async (upstream) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstream));
    const response = await GET(request());
    expect(response.headers.get("location")).toContain("error=login_failed");
    expect(response.cookies.getAll()).toEqual([]);
  });

  it("handles network failure without exposing error details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("PRIVATE_INTERNAL_ERROR")));
    const response = await GET(request());
    expect(response.headers.get("location")).toContain("error=login_failed");
    expect(response.cookies.getAll()).toEqual([]);
  });
});
