import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
const TOKEN = 'https://oauth2.googleapis.com/token';
const JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const MAX_BYTES = 65536;
export class AdminOidcError extends Error {
  constructor() { super('admin_authentication_failed'); this.name = 'AdminOidcError'; }
}
export function createPkce(): { verifier: string; codeChallenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, codeChallenge: createHash('sha256').update(verifier).digest('base64url') };
}
type Options = { clientId: string; clientSecret: string; redirectUri: string; fetch?: typeof fetch; now?: () => Date };
export class AdminOidcClient {
  private readonly options: Options;
  private readonly request: typeof fetch;
  private readonly now: () => Date;
  private keys: ReturnType<typeof createLocalJWKSet> | undefined;
  private keysUntil = 0;
  private loading: Promise<void> | undefined;
  constructor(options: Options) {
    let callback: URL;
    try { callback = new URL(options.redirectUri); } catch { throw new AdminOidcError(); }
    if (!options.clientId || !options.clientSecret || options.clientId.includes(':') ||
      /[\r\n]/u.test(options.clientId + options.clientSecret) || callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) throw new AdminOidcError();
    this.options = options;
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string {
    if (!input.state || !input.nonce || !/^[A-Za-z0-9_-]{43}$/u.test(input.codeChallenge)) throw new AdminOidcError();
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: this.options.clientId, redirect_uri: this.options.redirectUri,
      response_type: 'code', scope: 'openid email profile', state: input.state, nonce: input.nonce,
      code_challenge: input.codeChallenge, code_challenge_method: 'S256', prompt: 'select_account' }).toString();
    return url.toString();
  }
  private async json(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AdminOidcError()); }, 8000); });
    const work = async () => {
      const response = await this.request(url, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok || response.redirected || !response.body) throw new AdminOidcError();
      const reader = response.body.getReader();
      let size = 0;
      const parts: Uint8Array[] = [];
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > MAX_BYTES) throw new AdminOidcError();
          parts.push(item.value);
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) as unknown;
      } finally { await reader.cancel().catch(() => undefined); }
    };
    try { return await Promise.race([work(), deadline]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async loadKeys(force: boolean): Promise<void> {
    if (!force && this.keys && this.keysUntil > this.now().getTime()) return;
    if (!this.loading) {
      this.loading = (async () => {
        const data = await this.json(JWKS, { headers: { accept: 'application/json' } });
        if (!data || typeof data !== 'object' || !('keys' in data) || !Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 16) throw new AdminOidcError();
        for (const key of data.keys) {
          if (!key || typeof key !== 'object' || key.kty !== 'RSA' || typeof key.kid !== 'string' || key.kid.length > 256 || typeof key.n !== 'string' || typeof key.e !== 'string' || 'd' in key || (key.alg !== undefined && key.alg !== 'RS256') || (key.use !== undefined && key.use !== 'sig')) throw new AdminOidcError();
        }
        this.keys = createLocalJWKSet(data as JSONWebKeySet);
        this.keysUntil = this.now().getTime() + 300000;
      })();
    }
    try { await this.loading; } finally { this.loading = undefined; }
  }
  async exchangeAndVerify(input: { code: string; verifier: string; nonceHash: string }): Promise<{ issuer: string; subject: string; email: string; displayName: string }> {
    try {
      if (!input.code || input.code.length > 4096 || !/^[a-f0-9]{64}$/.test(input.nonceHash) || !/^[A-Za-z0-9._~-]{43,128}$/u.test(input.verifier)) throw new AdminOidcError();
      const result = await this.json(TOKEN, { method: 'POST', headers: {
        'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`).toString('base64')}`
      }, body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: this.options.redirectUri, code_verifier: input.verifier }).toString() });
      if (!result || typeof result !== 'object' || !('id_token' in result) || typeof result.id_token !== 'string') throw new AdminOidcError();
      await this.loadKeys(false);
      const verify = () => jwtVerify(result.id_token as string, async (header, token) => {
        if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256 || header.jku || header.jwk || header.x5u || header.x5c || header.crit) throw new AdminOidcError();
        return this.keys!(header, token);
      }, { algorithms: ['RS256'], issuer: [GOOGLE_ISSUER, 'accounts.google.com'], audience: this.options.clientId,
        currentDate: this.now(), clockTolerance: 30, requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'email', 'email_verified'] });
      let verified;
      try { verified = await verify(); } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error;
        await this.loadKeys(true);
        verified = await verify();
      }
      const p = verified.payload;
      const seconds = this.now().getTime() / 1000;
      if (typeof p.nonce !== 'string' || createHash('sha256').update(p.nonce).digest('hex') !== input.nonceHash || typeof p.sub !== 'string' || !p.sub || p.sub.length > 1024 ||
        (p.azp !== undefined && p.azp !== this.options.clientId) || (Array.isArray(p.aud) && p.aud.length > 1 && p.azp !== this.options.clientId) ||
        typeof p.iat !== 'number' || !Number.isInteger(p.iat) ||
        p.iat > seconds + 30 || seconds - p.iat > 300 || typeof p.exp !== 'number' || p.exp <= p.iat) throw new AdminOidcError();
      if (p.email_verified !== true || typeof p.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) || p.email.length > 254) throw new AdminOidcError();
      return { issuer: GOOGLE_ISSUER, subject: p.sub, email: p.email.toLowerCase(), displayName: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 100) : 'Operator' };
    } catch { throw new AdminOidcError(); }
  }
}
