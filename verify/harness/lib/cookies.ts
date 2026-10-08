import { APIResponse } from '@playwright/test';

// Set-Cookie as an adapter sent it, so a spec can hold every adapter to the same
// cookie attributes rather than trusting whatever the cookie jar kept.

export interface SetCookie {
  name: string;
  value: string;
  attributes: Record<string, string | true>;
}

export function setCookies(res: APIResponse): SetCookie[] {
  return res
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map(({ value }) => {
      const [pair, ...rest] = value.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      const attributes: Record<string, string | true> = {};

      for (const attribute of rest) {
        const at = attribute.indexOf('=');
        if (at === -1) attributes[attribute.toLowerCase()] = true;
        else attributes[attribute.slice(0, at).toLowerCase()] = attribute.slice(at + 1);
      }

      return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
    });
}

export function cookieNamed(res: APIResponse, name: string): SetCookie | undefined {
  return setCookies(res).find((cookie) => cookie.name === name);
}

/** A Set-Cookie that removes the cookie: empty, and expired or with no lifetime left. */
export function isCleared(cookie: SetCookie): boolean {
  const expires = cookie.attributes.expires;
  const maxAge = cookie.attributes['max-age'];

  return (
    (typeof expires === 'string' && Date.parse(expires) <= Date.now()) ||
    (typeof maxAge === 'string' && Number(maxAge) <= 0)
  );
}
