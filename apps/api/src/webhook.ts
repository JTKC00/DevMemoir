import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "@devmemoir/config";

export function verifyGithubSignature(rawBody: Buffer, signatureHeader: string | undefined, currentSecret: string, previousSecret?: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const presented = Buffer.from(signatureHeader.slice(7), "hex");
  if (presented.length !== 32) return false;
  const secrets = [currentSecret, ...(previousSecret ? [previousSecret] : [])];
  return secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  });
}

export function webhookBodyLimit(config: AppConfig): number {
  void config;
  return 2 * 1024 * 1024;
}
