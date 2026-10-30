---
"seamless-cli": minor
---

`seamless migrate assess <csv|entra-id|auth0|cognito> [source args] [--report <path>] [--json]` writes a readiness report from the source alone, with no Seamless Auth instance and no login. It reuses each source's parsing and validation and reports users found, how many would import and why the rest would not (including duplicate emails), contact coverage (verified email, phone only, neither), the roles and organization memberships that would be granted and the fields left behind, source features Seamless Auth does not cover (such as Auth0 enterprise connections or Cognito SAML providers, plus what an export cannot show, such as Cognito identity pools) with a link to the matching guide, and a link to the docs cost calculator with the user count filled in. The Markdown report holds counts and names of fields, roles and organizations, never a user's email, phone or id. `--json` prints the same assessment.
