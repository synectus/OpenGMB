# Third-party notices

OpenGMB is released under the MIT license (see [LICENSE](LICENSE)). It includes or depends on the third-party material below.

## Bundled font

- **Inter 4.1**, Copyright (c) 2016 The Inter Project Authors, licensed under the SIL Open Font License 1.1. It is embedded as base64 modules in `packages/core/src/postImages/fonts/`, with the license text in `packages/core/src/postImages/fonts/OFL.txt`. The font is used to draw text on generated post images.

## npm dependencies

Every dependency keeps its own license, which ships inside its package. List the production dependencies and their licenses with:

```sh
pnpm licenses list --prod
```

`pnpm check:repo-ready` checks every production dependency's license against the license of this repository. Most are MIT, ISC, Apache-2.0 or BSD. These need a named reason, and each is used unmodified:

| Package | License | Why it is acceptable |
| --- | --- | --- |
| `web-push` | MPL-2.0 | File-level copyleft. Used as a runtime dependency without changes, so MPL-2.0 applies only to its own files. |
| `lightningcss` | MPL-2.0 | Build-time CSS tooling, used without changes and not part of the shipped runtime code. |
| `@img/sharp-libvips-*` | LGPL-3.0-or-later | The native libvips library that `sharp` loads at run time, not modified. There is one package per platform. |
| `caniuse-lite` | CC-BY-4.0 | Browser support data. The attribution stays inside the package. |

## Not copied

OpenGMB does not copy code from GPL or AGPL projects. Where it works with such a project, it does so through that project's public API only.
