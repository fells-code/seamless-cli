// The harness waits on /health before it runs. nginx answers it in the
// production image; this answers it on `vite dev`, which has no fallback page.
export const prerender = true;

export function GET() {
  return new Response('ok');
}
