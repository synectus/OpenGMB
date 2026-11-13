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

## OpenSEO

Four small helper files for keyword research are ported from OpenSEO (https://github.com/every-app/open-seo) at commit `4fa42c879fd26657aec3472dcf44f08226816df3`, licensed MIT, and modified for OpenGMB. Each file carries a header naming its source path.

- `packages/core/src/seo/ported/openseo/interleave.ts`
- `packages/core/src/seo/ported/openseo/intent.ts`
- `packages/core/src/seo/ported/openseo/ads-keyword.ts`
- `packages/core/src/seo/ported/openseo/labs-items.ts`

```
MIT License

Copyright (c) 2026 Ben Senescu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Not copied

OpenGMB does not copy code from GPL or AGPL projects. Where it works with such a project, it does so through that project's public API only.
