---
"seamless-cli": patch
---

`seamless verify` holds the API to the step-up and registration contract from seamless-auth-api v0.24. A step-up only accepts a factor enrolled before the session signed in, so the step-up spec and the owner admin helper sign in again after enrolling a factor and step that session up. Registering an address that already has a verified account is answered as an unclaimed sign-up, so the owner signs in through `/login` once the account exists, and the owner admin spec checks that the owner holds the admin role either way. Both work against earlier API releases too.
