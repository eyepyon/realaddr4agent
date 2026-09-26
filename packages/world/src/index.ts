import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';

export const WORLD_ISSUER = 'https://sandbox.auth.world.org';
const TOKEN = `${WORLD_ISSUER}/api/v1/token`;
const JWKS = `${WORLD_ISSUER}/.well-known/jwks.json`;
const MAX_BYTES = 65536;
export class WorldError extends Error {
  constructor() { super('world_authentication_failed'); this.name = 'WorldError'; }
}
export function createPkce(): { verifier: string; codeChallenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, codeChallenge: createHash('sha256').update(verifier).digest('base64url') };
}
type Options = { clientId: string; clientSecret: string; redirectUri: string; fetch?: typeof fetch; now?: () => Date };
export class WorldClient {
  private readonly options: Options;
  private readonly request: typeof fetch;
  private readonly now: () => Date;
  private keys: ReturnType<typeof createLocalJWKSet> | undefined;
  private keysUntil = 0;
  private loading: Promise<void> | undefined;
  constructor(options: Options) {
    let callback: URL;
    try { callback = new URL(options.redirectUri); } catch { throw new WorldError(); }
    if (!options.clientId || !options.clientSecret || options.clientId.includes(':') ||
      /[\r\n]/u.test(options.clientId + options.clientSecret) || callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) throw new WorldError();
    this.options = options;
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string {
    if (!input.state || !input.nonce || !/^[A-Za-z0-9_-]{43}$/u.test(input.codeChallenge)) throw new WorldError();
    const url = new URL(`${WORLD_ISSUER}/api/v1/authorize`);
    url.search = new URLSearchParams({ client_id: this.options.clientId, redirect_uri: this.options.redirectUri,
      response_type: 'code', scope: 'openid', state: input.state, nonce: input.nonce,
      code_challenge: input.codeChallenge, code_challenge_method: 'S256', prompt: 'login', max_age: '0' }).toString();
    return url.toString();
  }
  private async json(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new WorldError()); }, 8000); });
    const work = async () => {
      const response = await this.request(url, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok || response.redirected || !response.body) throw new WorldError();
      const reader = response.body.getReader();
      let size = 0;
      const parts: Uint8Array[] = [];
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > MAX_BYTES) throw new WorldError();
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
        if (!data || typeof data !== 'object' || !('keys' in data) || !Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 16) throw new WorldError();
        for (const key of data.keys) {
          if (!key || typeof key !== 'object' || key.kty !== 'RSA' || typeof key.kid !== 'string' || key.kid.length > 256 || typeof key.n !== 'string' || typeof key.e !== 'string' || 'd' in key || (key.alg !== undefined && key.alg !== 'RS256') || (key.use !== undefined && key.use !== 'sig')) throw new WorldError();
        }
        this.keys = createLocalJWKSet(data as JSONWebKeySet);
        this.keysUntil = this.now().getTime() + 300000;
      })();
    }
    try { await this.loading; } finally { this.loading = undefined; }
  }
  async exchangeAndVerify(input: { code: string; verifier: string; nonce: string; startedAt: Date }): Promise<{ issuer: string; subject: string; authTime: Date }> {
    try {
      if (!input.code || input.code.length > 4096 || !input.nonce || !/^[A-Za-z0-9._~-]{43,128}$/u.test(input.verifier) || !Number.isFinite(input.startedAt.getTime())) throw new WorldError();
      const result = await this.json(TOKEN, { method: 'POST', headers: {
        'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`).toString('base64')}`
      }, body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: this.options.redirectUri, code_verifier: input.verifier }).toString() });
      if (!result || typeof result !== 'object' || !('id_token' in result) || typeof result.id_token !== 'string') throw new WorldError();
      await this.loadKeys(false);
      const verify = () => jwtVerify(result.id_token as string, async (header, token) => {
        if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256 || header.jku || header.jwk || header.x5u || header.x5c || header.crit) throw new WorldError();
        return this.keys!(header, token);
      }, { algorithms: ['RS256'], issuer: WORLD_ISSUER, audience: this.options.clientId,
        currentDate: this.now(), clockTolerance: 30, requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'auth_time'] });
      let verified;
      try { verified = await verify(); } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error;
        await this.loadKeys(true);
        verified = await verify();
      }
      const p = verified.payload;
      const seconds = this.now().getTime() / 1000;
      if (p.nonce !== input.nonce || typeof p.sub !== 'string' || !p.sub || p.sub.length > 1024 ||
        (p.azp !== undefined && p.azp !== this.options.clientId) || (Array.isArray(p.aud) && p.aud.length > 1 && p.azp !== this.options.clientId) ||
        typeof p.auth_time !== 'number' || !Number.isInteger(p.auth_time) || p.auth_time < input.startedAt.getTime() / 1000 - 30 ||
        p.auth_time > seconds + 30 || seconds - p.auth_time > 300 || typeof p.iat !== 'number' || !Number.isInteger(p.iat) ||
        p.iat > seconds + 30 || seconds - p.iat > 300 || typeof p.exp !== 'number' || p.exp <= p.iat) throw new WorldError();
      return { issuer: WORLD_ISSUER, subject: p.sub, authTime: new Date(p.auth_time * 1000) };
    } catch { throw new WorldError(); }
  }
}
