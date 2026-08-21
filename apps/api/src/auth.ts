import {
  createId,
  createOpaqueToken,
  createPkcePair,
  decryptSecret,
  encryptSecret,
  hashOpaqueToken,
} from "@devmemoir/domain";
import type { AppConfig } from "@devmemoir/config";
import type { GithubClient } from "@devmemoir/github";
import type { M1Store, UserRecord, SessionRecord } from "@devmemoir/db";

export class AuthFlowError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "AuthFlowError";
  }
}

export type AuthStartResult = { authorizationUrl: string; state: string };

export class AuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: M1Store,
    private readonly github: GithubClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async startLogin(returnPath = "/"): Promise<AuthStartResult> {
    if (!returnPath.startsWith("/") || returnPath.startsWith("//") || returnPath.includes("\\")) throw new AuthFlowError("Invalid return path", 400);
    const state = createOpaqueToken(32);
    const { verifier, challenge } = createPkcePair();
    const stateHash = hashOpaqueToken(state, this.config.SESSION_SECRET);
    const expiresAt = new Date(this.now().getTime() + this.config.AUTH_TRANSACTION_TTL_SECONDS * 1000);
    await this.store.createAuthTransaction({ id: createId(), stateHash, codeVerifierCiphertext: encryptSecret(verifier, this.config.ENCRYPTION_KEY_BASE64), returnPath, expiresAt });
    const callback = `${this.config.API_ORIGIN}/auth/github/callback`;
    const query = new URLSearchParams({ client_id: this.config.GITHUB_APP_CLIENT_ID, redirect_uri: callback, state, code_challenge: challenge, code_challenge_method: "S256", scope: "read:user" });
    return { authorizationUrl: `https://github.com/login/oauth/authorize?${query.toString()}`, state };
  }

  async completeLogin(input: { code: string; state: string }): Promise<{ handoffCode: string; returnPath: string; user: UserRecord }> {
    const stateHash = hashOpaqueToken(input.state, this.config.SESSION_SECRET);
    const transaction = await this.store.consumeAuthState(stateHash, this.now());
    if (!transaction) throw new AuthFlowError("Invalid, expired, or replayed state", 400);
    const verifier = decryptSecret(transaction.codeVerifierCiphertext, this.config.ENCRYPTION_KEY_BASE64);
    const clientSecret = this.config.GITHUB_APP_CLIENT_SECRET;
    if (!clientSecret) throw new AuthFlowError("GitHub App client secret is not configured", 503);
    const token = await this.github.exchangeOAuthCode({ code: input.code, clientId: this.config.GITHUB_APP_CLIENT_ID, clientSecret, redirectUri: `${this.config.API_ORIGIN}/auth/github/callback`, codeVerifier: verifier });
    const githubUser = await this.github.getUser(token.accessToken);
    if (githubUser.id !== this.config.OWNER_GITHUB_USER_ID || githubUser.type && githubUser.type !== "User") throw new AuthFlowError("GitHub account is not allowlisted", 403);
    const existing = await this.store.getUserByGithubAccountId(githubUser.id);
    const user: UserRecord = existing ?? { userId: createId(), tenantId: createId(), githubAccountId: githubUser.id, login: githubUser.login, displayName: githubUser.login };
    await this.store.attachAuthUser(stateHash, user);
    const handoffCode = createOpaqueToken(32);
    await this.store.createHandoff(stateHash, hashOpaqueToken(handoffCode, this.config.SESSION_SECRET), new Date(this.now().getTime() + this.config.HANDOFF_TTL_SECONDS * 1000));
    return { handoffCode, returnPath: transaction.returnPath, user };
  }

  async exchangeHandoff(code: string): Promise<{ sessionToken: string; csrfToken: string; user: UserRecord }> {
    const user = await this.store.consumeHandoff(hashOpaqueToken(code, this.config.SESSION_SECRET), this.now());
    if (!user) throw new AuthFlowError("Invalid, expired, or replayed handoff", 400);
    const sessionToken = createOpaqueToken(32);
    const csrfToken = createOpaqueToken(24);
    const session: SessionRecord = {
      userId: user.userId,
      tenantId: user.tenantId,
      tokenHash: hashOpaqueToken(sessionToken, this.config.SESSION_SECRET),
      csrfTokenHash: hashOpaqueToken(csrfToken, this.config.SESSION_SECRET),
      expiresAt: new Date(this.now().getTime() + this.config.SESSION_TTL_SECONDS * 1000),
    };
    await this.store.createSession(session);
    return { sessionToken, csrfToken, user };
  }

  async authenticate(sessionToken: string | undefined): Promise<SessionRecord | undefined> {
    if (!sessionToken) return undefined;
    return this.store.getSession(hashOpaqueToken(sessionToken, this.config.SESSION_SECRET), this.now());
  }

  async verifyCsrf(session: SessionRecord, csrfToken: string | undefined): Promise<boolean> {
    return Boolean(csrfToken && hashOpaqueToken(csrfToken, this.config.SESSION_SECRET) === session.csrfTokenHash);
  }
}

export function readBearerOrCookie(input: { authorization?: string; cookie?: string; cookies?: Record<string, string | undefined> }): string | undefined {
  if (input.authorization?.startsWith("Bearer ")) return input.authorization.slice(7);
  return input.cookies?.["__Host-devmemoir_session"];
}
