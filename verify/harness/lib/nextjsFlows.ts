import { expect, Page } from '@playwright/test';

// Browser-facing helpers for the Next.js full-stack starter (served at REACT_URL).
// It serves /auth itself and renders its own sign-in screen (src/components/
// SignIn.tsx in the template), so these drive that screen rather than the SDK's
// bundled one. Codes come from the starter's own capture readout, which
// SEAMLESS_VERIFY_CAPTURE turns on in the conformance stack.
//
// The readout is fetched from the page, so it goes wherever the browser goes for
// the app's origin (see the host resolver rule in playwright.config.ts).

const capturePath = (recipient: string) =>
  `/api/verify-capture/${encodeURIComponent(recipient)}`;

async function readCaptureBody(
  page: Page,
  recipient: string,
): Promise<{ token?: unknown; magicLinkUrl?: unknown } | null> {
  const { status, body } = await page.evaluate(async (path) => {
    const res = await fetch(path, { cache: 'no-store' });
    return { status: res.status, body: res.ok ? await res.json() : null };
  }, capturePath(recipient));
  expect(status, `capture readout -> ${status} (is SEAMLESS_VERIFY_CAPTURE set?)`).toBe(200);
  return body;
}

async function readCapture(page: Page, recipient: string): Promise<string | undefined> {
  const body = await readCaptureBody(page, recipient);
  return body?.token ? String(body.token) : undefined;
}

/**
 * The magic link the starter captured for `recipient`, as a path on the app's origin
 * (`/verify-magiclink?token=T#code=C`). Pass the token captured before the request as
 * `previous` to wait for the new link.
 */
export async function readStarterMagicLink(
  page: Page,
  recipient: string,
  previous?: string,
): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const body = await readCaptureBody(page, recipient);
        if (!body?.magicLinkUrl || String(body.token) === previous) return false;
        const url = new URL(String(body.magicLinkUrl));
        link = `${url.pathname}${url.search}${url.hash}`;
        return true;
      },
      { message: `a new magic link captured for ${recipient}`, timeout: 10_000 },
    )
    .toBe(true);
  return link!;
}

/** The latest code the starter captured for `recipient`, or undefined if none yet. */
export function lastCapturedCode(page: Page, recipient: string): Promise<string | undefined> {
  return readCapture(page, recipient);
}

/** Wait for a code captured for `recipient` other than `previous`. */
export async function readStarterCode(
  page: Page,
  recipient: string,
  previous?: string,
): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        code = await readCapture(page, recipient);
        return code !== undefined && code !== previous;
      },
      { message: `a new code captured for ${recipient}`, timeout: 10_000 },
    )
    .toBe(true);
  return code!;
}

/** The navbar shows the signed-in user's address and a sign-out button. */
export async function expectSignedIn(page: Page, email: string): Promise<void> {
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('banner').getByText(email)).toBeVisible();
}

/** Open the sign-in screen and submit an identifier. */
export async function startSignIn(page: Page, email: string, path = '/login'): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.locator('#identifier').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

/** Type a code into the starter's single code field and submit it. */
export async function enterCode(page: Page, code: string): Promise<void> {
  await page.locator('#code').fill(code);
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
}

/** Create an account by email, then enroll a passkey (passkey support must be on). */
export async function registerWithPasskey(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
  const previous = await lastCapturedCode(page, email);
  await page.locator('#identifier').fill(email);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();

  await enterCode(page, await readStarterCode(page, email, previous));

  await expect(page.getByRole('heading', { name: 'Add a passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a passkey', exact: true }).click();
}

/** Sign in an existing verified user with an emailed one-time code. */
export async function signInWithEmailCode(page: Page, email: string, path = '/login'): Promise<void> {
  await startSignIn(page, email, path);
  const previous = await lastCapturedCode(page, email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await enterCode(page, await readStarterCode(page, email, previous));
}
