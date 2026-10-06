import { createECDH, createHash, createPrivateKey, randomUUID, sign } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

// Minimal OIDC identity provider for the OAuth conformance flows: /authorize, /token
// (PKCE), /userinfo, and /jwks. The token response always carries a signed ID token,
// which only a provider configured with `issuer` and `jwksUri` makes the API verify
// and read; the plain `mock` provider ignores it and calls /userinfo.
//
// /authorize mints a fresh user unless the caller names one with `mock_sub`,
// `mock_email` and `mock_oid`. The harness appends those to the authorization URL the
// API returned, so a spec can sign in as a user it imported beforehand.

export const MOCK_OIDC_ISSUER = 'http://mock-oidc.verify';

interface Profile {
  sub: string;
  email: string;
  oid: string;
}

interface PendingCode {
  codeChallenge?: string;
  redirectUri: string;
  clientId: string;
  nonce?: string;
  profile: Profile;
}

const sha256Base64Url = (value: string): string =>
  createHash('sha256').update(value).digest('base64url');

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// The signing key is derived from a fixed seed so every run serves the same key. The
// API caches a provider's JWKS and will not refetch for an unknown key id within its
// cooldown, so a fresh key per run made a quick local re-run fail verification. It is
// a test key for a mock provider and signs nothing else.
function signingKey() {
  const d = createHash('sha256').update('seamless-verify-mock-oidc').digest();
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  const coordinates = {
    kty: 'EC',
    crv: 'P-256',
    x: point.subarray(1, 33).toString('base64url'),
    y: point.subarray(33, 65).toString('base64url'),
  };
  return {
    privateKey: createPrivateKey({
      key: { ...coordinates, d: d.toString('base64url') },
      format: 'jwk',
    }),
    jwk: { ...coordinates, kid: 'mock-oidc-es256', alg: 'ES256', use: 'sig' },
  };
}

export function startMockOidc(port: number): Server {
  const codes = new Map<string, PendingCode>();
  const tokens = new Map<string, Profile>();
  const { privateKey, jwk } = signingKey();

  const idToken = (pending: PendingCode): string => {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const data = `${encode({ alg: 'ES256', typ: 'JWT', kid: jwk.kid })}.${encode({
      iss: MOCK_OIDC_ISSUER,
      aud: pending.clientId,
      sub: pending.profile.sub,
      oid: pending.profile.oid,
      email: pending.profile.email,
      email_verified: true,
      name: 'OAuth User',
      iat: now,
      exp: now + 600,
      ...(pending.nonce ? { nonce: pending.nonce } : {}),
    })}`;
    // JWS wants the raw r || s signature, not DER.
    const signature = sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${data}.${signature.toString('base64url')}`;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/jwks') {
      sendJson(res, 200, { keys: [jwk] });
      return;
    }

    // Authorization endpoint: mint a code bound to the PKCE challenge, the nonce and
    // the user, then redirect back to the app's redirect_uri with code + state.
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      if (!redirectUri) {
        sendJson(res, 400, { error: 'invalid_request', error_description: 'missing redirect_uri' });
        return;
      }
      const code = randomUUID();
      codes.set(code, {
        codeChallenge: url.searchParams.get('code_challenge') ?? undefined,
        redirectUri,
        clientId: url.searchParams.get('client_id') ?? '',
        nonce: url.searchParams.get('nonce') ?? undefined,
        profile: {
          sub: url.searchParams.get('mock_sub') ?? `mock-${randomUUID()}`,
          email:
            url.searchParams.get('mock_email') ?? `oauth.${randomUUID().slice(0, 12)}@example.test`,
          oid: url.searchParams.get('mock_oid') ?? randomUUID(),
        },
      });
      const location = new URL(redirectUri);
      location.searchParams.set('code', code);
      location.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { Location: location.toString() });
      res.end();
      return;
    }

    // Token endpoint: validate PKCE (S256), consume the code, issue an opaque access
    // token and a signed ID token.
    if (req.method === 'POST' && url.pathname === '/token') {
      void readBody(req).then((raw) => {
        const params = new URLSearchParams(raw);
        const code = params.get('code') ?? '';
        const pending = codes.get(code);
        if (!pending) {
          sendJson(res, 400, { error: 'invalid_grant' });
          return;
        }
        codes.delete(code);
        if (
          pending.codeChallenge &&
          sha256Base64Url(params.get('code_verifier') ?? '') !== pending.codeChallenge
        ) {
          sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
          return;
        }
        const accessToken = randomUUID();
        tokens.set(accessToken, pending.profile);
        sendJson(res, 200, {
          access_token: accessToken,
          id_token: idToken(pending),
          token_type: 'Bearer',
          expires_in: 3600,
        });
      });
      return;
    }

    // Userinfo endpoint: return the profile for the bearer access token.
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const profile = tokens.get(token);
      if (!profile) {
        sendJson(res, 401, { error: 'invalid_token' });
        return;
      }
      sendJson(res, 200, {
        sub: profile.sub,
        email: profile.email,
        email_verified: true,
        name: 'OAuth User',
      });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });

  // Bind on all interfaces so the API container can reach it via host.docker.internal;
  // unref so it never keeps the Playwright process alive after the run.
  server.listen(port, '0.0.0.0');
  server.unref();
  return server;
}
