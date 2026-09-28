# `@app/shared`

The application's identity, shared by the API, the web app and the CLI: the
display name, the repository slug and the two brand colours.

| Export | Source | Notes |
|---|---|---|
| `APP_NAME` | `identity.json` → `productName` | |
| `THEME_COLOR` | `identity.json` → `themeColor` | MUI primary colour, manifest `theme_color`, brand icons |
| `BACKGROUND_COLOR` | `identity.json` → `backgroundColor` | Manifest `background_color`, icon backgrounds |
| `REPO_SLUG` | `identity.json` → `repoSlug` | `owner/name`; published in the OpenAPI document |
| `REPO_URL` | derived from `REPO_SLUG` | `https://github.com/<slug>` |
| `APP_SLUG` | derived from `APP_NAME` | Lowercase, hyphenated |

[`index.js`](./index.js) holds no literal values. It reads
[`identity.json`](./identity.json) and derives the rest.

## Rebranding a fork

Do not edit these files by hand. Run the codemod:

```bash
node scripts/rename.mjs --name "Acme Hub" --repo acme/acme-hub --theme '#7c3aed'
```

`scripts/rename.mjs` reads the current values from `identity.json`, rewrites
it, and then rewrites every identity string that cannot read this package at
runtime (Compose defaults, `install.sh`, the README title and so on). It also
regenerates the brand icons when a colour changes. See
[`docs/RENAMING.md`](../../docs/RENAMING.md) for every flag, the manual steps
that follow (lockfile, visual baselines, GitHub remote, OAuth redirect URIs)
and the strings that must never be renamed.

The CLI binary name (`appctl`, `CLI_NAME` in `apps/cli/src/branding.ts`) is
deliberately separate and is not derived from `APP_NAME`.

## Consumers

Keep this list current when you add one.

| Consumer | File | Uses |
|---|---|---|
| Web wordmark (AppBar) | `apps/web/src/components/navigation/AppBar.tsx` | `APP_NAME` |
| Web page title and meta description | `apps/web/index.html` via the `%APP_NAME%` plugin in `apps/web/vite.config.ts` | `APP_NAME` |
| OpenAPI title, contact and docs link | `apps/api/src/openapi/document.ts` | `APP_NAME`, `REPO_URL` |
| OpenAPI description prose | `apps/api/src/openapi/description.ts` | `APP_NAME`, `REPO_URL` |
| API reference page heading and `<title>` | `apps/api/src/openapi/docs-page.ts`, `register-docs-routes.ts` | `APP_NAME` |
| Email wordmark, footer and subjects | `apps/api/src/email/templates/layout.ts` | `APP_NAME` |
| CLI banner, `--help`, device name | `apps/cli/src/branding.ts` (`CLI_DISPLAY_NAME`) | `APP_NAME` |
| Web theme (`palette.primary.main`, light) | `apps/web/src/theme/light.ts` | `THEME_COLOR` |
| Web app manifest | `apps/web/pwa/manifest.ts` | `APP_NAME`, `THEME_COLOR`, `BACKGROUND_COLOR` |
| Brand icons and favicon (generated pixels) | `apps/web/public/icons/*.png`, `apps/web/public/favicon.ico` via `apps/web/scripts/generate-icons.py` | `THEME_COLOR`, `BACKGROUND_COLOR` |

## Brand icons

Everything under `apps/web/public/icons/`, plus `public/favicon.svg` and
`public/favicon.ico`. The PNGs are committed pixels, so a colour change only
reaches them when they are regenerated:

```bash
python3 apps/web/scripts/generate-icons.py   # needs Python 3 + Pillow>=10
```

`scripts/rename.mjs` runs this for you and prints the command if Python or
Pillow is missing. `icon-192.png` and `badge-96.png` are also the icon and
badge on every OS-level notification (`apps/web/src/sw.ts`,
`apps/web/src/services/browserNotifications.ts`), so a skipped regeneration
shows the old brand on every push notification.

The generator redraws the placeholder mark in Pillow; it does not rasterise
`icons/source.svg`. Once you have a real logo, export the PNGs from your design
tool at the same sizes, keeping each file's alpha rules (maskable icons
full-bleed, `badge-96.png` white on transparent, the iOS icon with no alpha).

## Consuming it from a Vite app

Add the package to `optimizeDeps.include`:

```ts
optimizeDeps: { include: ['@app/shared'] },
```

The package is CommonJS and arrives as a workspace symlink, so Vite serves it
as raw ESM unless it is pre-bundled, and the dev server renders a blank page
(`does not provide an export named 'APP_NAME'`). `tsc`, Vitest and `vite build`
all stay green while this is broken. `apps/web/vite.config.ts` and
`apps/web/visual/vite.config.ts` both carry the line.

## Packaging

Committed CommonJS plus a hand-written `index.d.ts`, with no build step. The
reasons (the API's `rootDir`, its Jest transform, the CLI's ESM runtime) are in
the header of [`index.js`](./index.js).

## Adding another constant

Add the value to `identity.json` if it is an identity fact, export it from
`index.js`, declare it in `index.d.ts`, and add a row to the consumers table.
Anything Node-only, Nest-only or DOM-only does not belong here: all three apps
import this package.
