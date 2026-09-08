import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logout, revokeAllSessions } from "./session-actions";

const jar = vi.hoisted(() => ({ toString: () => "fixture-cookie", get: () => ({ value: "fixture-csrf" }), set: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => jar }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
beforeEach(() => { jar.set.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("session actions", () => {
  it("expires host-only secure cookies after server-side revocation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(logout()).rejects.toThrow("redirect:/");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/auth/logout"), expect.objectContaining({ method: "POST", headers: { cookie: "fixture-cookie", "x-devmemoir-csrf": "fixture-csrf" }, cache: "no-store" }));
    expect(jar.set).toHaveBeenCalledWith("__Host-devmemoir_session", "", expect.objectContaining({ secure: true, httpOnly: true, path: "/", maxAge: 0 }));
    expect(jar.set).toHaveBeenCalledWith("devmemoir_csrf", "", expect.objectContaining({ secure: true, path: "/", maxAge: 0 }));
  });

  it("clears an already-expired session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    await expect(logout()).rejects.toThrow("redirect:/");
    expect(jar.set).toHaveBeenCalledTimes(2);
  });

  it.each([403, 503])("preserves cookies when revocation returns %s so the owner can retry", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    await expect(revokeAllSessions()).rejects.toThrow("redirect:/connect?error=session_revocation_failed");
    expect(jar.set).not.toHaveBeenCalled();
  });

  it("preserves cookies when the revocation service is unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(revokeAllSessions()).rejects.toThrow("redirect:/connect?error=session_revocation_failed");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/auth/sessions/revoke"), expect.anything());
    expect(jar.set).not.toHaveBeenCalled();
  });
});
