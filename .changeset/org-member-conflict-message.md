---
"seamless-cli": patch
---

`seamless org members add` now says the user is already a member when the instance answers 409, instead of a bare `Request failed (409).` (an organization's creator is a member automatically, so adding yourself after `org create` hits this). A 404 on add no longer claims the organization is missing when it is the user. The other `org` and `users` commands name the action that failed and include the instance's own error message, for example `Could not update member (400: Organization must keep at least one owner).`
