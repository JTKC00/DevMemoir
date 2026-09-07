// Synthetic webhook secrets used only for HMAC verification tests.
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyGithubSignature } from "./webhook.js";

describe("GitHub webhook signature", () => {
  it("validates exact Unicode raw bytes and supports rotation overlap", () => {
    const raw = Buffer.from(JSON.stringify({ message: "私密 commit 🚀" }), "utf8");
    const signature = `sha256=${createHmac("sha256", "previous-secret-123456").update(raw).digest("hex")}`;
    expect(verifyGithubSignature(raw, signature, "current-secret-123456", "previous-secret-123456")).toBe(true);
    expect(verifyGithubSignature(raw, signature, "current-secret-123456")).toBe(false);
  });

  it("rejects malformed signatures", () => {
    expect(verifyGithubSignature(Buffer.from("{}"), "sha256=bad", "current-secret-123456")).toBe(false);
  });

  it("accepts both signers during overlap, then only the current signer after restart", () => {
    const raw = Buffer.from('{"zen":"synthetic rotation rehearsal"}');
    const oldSecret = "fixture-old-webhook-secret";
    const newSecret = "fixture-new-webhook-secret";
    const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    for (const secret of [oldSecret, newSecret]) expect(verifyGithubSignature(raw, sign(secret), newSecret, oldSecret)).toBe(true);
    expect(verifyGithubSignature(raw, sign(oldSecret), newSecret)).toBe(false);
    expect(verifyGithubSignature(raw, sign(newSecret), newSecret)).toBe(true);
    expect(verifyGithubSignature(Buffer.from("changed"), sign(newSecret), newSecret)).toBe(false);
  });
});
