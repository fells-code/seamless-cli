---
"seamless-cli": minor
---

New `seamless migrate entra-id` imports users straight from Microsoft Entra ID through Microsoft Graph, with the same dry run, batches and report as `migrate csv`. Each user's Entra object id becomes their `externalId`, so re-runs match people without a hand-edited export. It signs in as an app registration with app-only `User.Read.All` (and `GroupMember.Read.All` for groups), reading `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` and `ENTRA_CLIENT_SECRET` from the environment only. `--group` imports one group's members, `--groups` maps groups to organizations and roles, disabled accounts and guests are skipped and reported, and `--allow-upn` uses the `userPrincipalName` for users with no mail.

Migration reports gain a `skipped` count and status, for rows left out on purpose. Skipped rows do not make the command exit 1.
