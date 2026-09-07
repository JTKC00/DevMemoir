import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { OctokitGithubClient } from "./index.js";

afterEach(() => vi.unstubAllGlobals());

it("recreates App JWT clients across private-key overlap and rejects the revoked signer", async () => {
  const previous = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const current = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let accepted: KeyObject[] = [previous.publicKey];
  let calls = 0;
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    expect(String(url)).toBe("https://api.github.com/app/installations/22");
    calls++;
    const jwt = new Headers(options.headers).get("authorization")?.replace(/^bearer /i, "") ?? "";
    const [header, payload, signature] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(String(claims.iss)).toBe("1");
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    const valid = accepted.some((key) => verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature!, "base64url")));
    return new Response(JSON.stringify(valid ? { id: 22, account: { id: 7, login: "fixture", type: "User" } } : { message: "Bad credentials" }), { status: valid ? 200 : 401, headers: { "content-type": "application/json" } });
  });
  const client = (key: KeyObject) => new OctokitGithubClient({ appId: 1, privateKey: key.export({ type: "pkcs8", format: "pem" }).toString() });
  const oldProcess = client(previous.privateKey);
  expect((await oldProcess.getInstallation(22)).id).toBe(22);
  accepted = [previous.publicKey, current.publicKey];
  const newProcess = client(current.privateKey);
  expect((await oldProcess.getInstallation(22)).id).toBe(22);
  expect((await newProcess.getInstallation(22)).id).toBe(22);
  accepted = [current.publicKey];
  await expect(oldProcess.getInstallation(22)).rejects.toMatchObject({ status: 401 });
  expect((await newProcess.getInstallation(22)).id).toBe(22);
  expect(calls).toBe(5);
});
