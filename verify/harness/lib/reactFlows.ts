import { BrowserContext, expect, Page, request } from '@playwright/test';

import { ADAPTER_URL } from './env';

// Browser-facing helpers for the React starter (served at REACT_URL, pointed at
// the adapter). The adapter strips OTP/magic-link secrets from browser responses,
// so codes are read from its /__captured readout (same seam as adapterFlows).

/** Read a code the adapter captured for `recipient` (email or phone), polling until present. */
export function readCapturedCode(recipient: string, timeoutMs = 10_000): Promise<string> {
  return pollCaptured(
    `${ADAPTER_URL}/__captured/${encodeURIComponent(recipient)}`,
    recipient,
    timeoutMs,
  );
}

/**
 * Poll a capture readout (`{ token }`, or null until something was sent) until it
 * holds a code. The adapter and the full-stack starters each serve one. A readout
 * keeps the latest code per recipient, so pass `previous` to wait for a new one.
 */
export async function pollCaptured(
  url: string,
  recipient: string,
  timeoutMs = 10_000,
  previous?: string,
): Promise<string> {
  const ctx = await request.newContext();
  try {
    const deadline = Date.now() + timeoutMs;
    let last = 'never set';
    while (Date.now() < deadline) {
      const res = await ctx.get(url);
      if (res.ok()) {
        const body = await res.json();
        if (body?.token && String(body.token) !== previous) return String(body.token);
        last = JSON.stringify(body);
      } else {
        last = `status ${res.status()}`;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`no captured code for ${recipient} within ${timeoutMs}ms (last: ${last})`);
  } finally {
    await ctx.dispose();
  }
}

/**
 * Open the sign-in form. The SDK usually renders the register form by default, but
 * lands directly on sign-in in some states (e.g. just after logout), so switch only
 * when needed — and wait for the form to render first to avoid racing the SPA.
 */
export async function gotoSignIn(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /Sign In|Create Account/ })).toBeVisible();
  if (await page.getByRole('heading', { name: 'Create Account' }).isVisible()) {
    await page.getByRole('button', { name: /Already have an account/i }).click();
  }
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
}

/** Type a code into the SDK's six-box OTP input (one digit per box). */
export async function enterOtp(page: Page, code: string): Promise<void> {
  const boxes = page.getByLabel(/^Digit \d$/);
  await expect(boxes).toHaveCount(code.length);
  await boxes.first().click();
  await page.keyboard.type(code);
}

/**
 * Attach a CTAP2 platform virtual authenticator (Chrome DevTools Protocol) so
 * WebAuthn ceremonies auto-succeed — this is what makes `isUVPAA()` true (so the
 * SDK offers passkeys) and lets navigator.credentials.create/get resolve headless.
 */
export async function addVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/** Register a new user by email, then enroll a passkey (passkey support must be on). */
export async function registerWithPasskey(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Create Account' })).toBeVisible();
  await page.locator('#email').fill(email);
  await page.getByRole('button', { name: 'Register', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Verify Your Email' })).toBeVisible();
  await enterOtp(page, await readCapturedCode(email));
  await page.getByRole('button', { name: /Verify & Continue/ }).click();

  // Passkey support is detected, so registration continues to passkey enrollment.
  await expect(
    page.getByRole('heading', { name: /Secure Your Account with a Passkey/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Register Passkey' }).click();
}

/** Sign in an existing user whose passkey is registered (the ceremony auto-runs). */
export async function loginWithPasskey(page: Page, email: string): Promise<void> {
  await gotoSignIn(page);
  await page.locator('#identifier').fill(email);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
}

/** Sign in an existing verified user through the email one-time-code path. */
export async function signInWithEmailOtp(page: Page, email: string): Promise<void> {
  await gotoSignIn(page);
  await page.locator('#identifier').fill(email);
  await page.getByRole('button', { name: 'Login', exact: true }).click();

  await page.getByRole('button', { name: /Email Code/ }).click();
  await expect(page.getByRole('heading', { name: 'Verify Your Email' })).toBeVisible();

  await enterOtp(page, await readCapturedCode(email));
  await page.getByRole('button', { name: /Verify & Continue/ }).click();
  await expect(page.getByText('You are signed in')).toBeVisible();
}

