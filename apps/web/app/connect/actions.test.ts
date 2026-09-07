import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ set: vi.fn(), fetch: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "synthetic-session" }), cookies: async () => ({ get: () => ({ value: "synthetic-csrf" }), set: mocks.set }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
import { deleteAccount } from "./actions";

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", mocks.fetch); });
afterEach(() => vi.unstubAllGlobals());
const confirmed = () => { const form = new FormData(); form.set("confirm", "delete_account"); return form; };

it("does not request deletion without explicit confirmation", async () => {
  await expect(deleteAccount(new FormData())).rejects.toThrow("deletion_confirmation_required");
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.set).not.toHaveBeenCalled();
});
it.each(["unavailable", "rejected"])("does not claim success or clear cookies when deletion is %s", async (failure) => {
  if (failure === "unavailable") mocks.fetch.mockRejectedValueOnce(new Error("offline"));
  else mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(deleteAccount(confirmed())).rejects.toThrow("account_deletion_failed");
  expect(mocks.set).not.toHaveBeenCalled();
});
it("expires both secure cookies only after the API accepts deletion", async () => {
  mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 202 }));
  await expect(deleteAccount(confirmed())).rejects.toThrow("redirect:/account/deletion-requested");
  expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining("/account/delete"), expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-devmemoir-csrf": "synthetic-csrf" }), body: JSON.stringify({ confirm: "delete_account" }) }));
  expect(mocks.set).toHaveBeenCalledTimes(2);
  for (const [, value, attributes] of mocks.set.mock.calls) {
    expect(value).toBe("");
    expect(attributes).toMatchObject({ secure: true, path: "/", maxAge: 0 });
  }
});
