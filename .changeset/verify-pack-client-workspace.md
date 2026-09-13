---
'seamless-cli': patch
---

`seamless verify --local` packs `@seamless-auth/client` alongside `@seamless-auth/react`
when the React SDK checkout is an npm workspace.

The client SDK repo is becoming a workspace that publishes a framework-agnostic
`@seamless-auth/client` next to `@seamless-auth/react`, and the react tarball depends on
the client one. Packing only the root of such a checkout would produce the private root
package, and installing the react tarball alone would go to the registry for a client
version that is not published yet. The harness now reads `workspaces` from the checkout's
`package.json`, packs both packages when it finds one, and the react image installs every
tarball in one `npm install` so the dependency resolves from the sibling file. A checkout
that predates the workspace is packed as before. The version line reported for
`@seamless-auth/react` reads the react package's own manifest in a workspace.
