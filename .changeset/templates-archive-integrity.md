---
"seamless-cli": patch
---

`seamless init` now downloads the starter templates by the commit their release tag pointed at when the CLI was published, rather than by the tag, so a moved tag cannot change what a scaffold extracts. Template extraction also fails with a clear error on an archive entry that would write outside the project, as the `--admin=source` dashboard download already did. `SEAMLESS_TEMPLATES_REF` and `SEAMLESS_TEMPLATES_DIR` still override the source as before.
