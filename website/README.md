# AFK documentation website

The public documentation site for AFK, built with [Astro](https://astro.build)
and [Starlight](https://starlight.astro.build).

## Develop

```sh
cd website
bun install
bun run dev        # http://localhost:4321
```

| Command           | Action                                    |
| ----------------- | ----------------------------------------- |
| `bun run dev`     | Start the local dev server                |
| `bun run build`   | Build the production site to `./dist/`    |
| `bun run preview` | Preview the built site locally            |
| `bun run check`   | Type-check content and config             |

## Structure

```
website/
├── astro.config.mjs        # site config + sidebar
├── src/
│   ├── assets/logo.svg     # brand mark
│   ├── content/docs/       # all pages (Markdown / MDX)
│   │   ├── index.mdx        #   landing (splash)
│   │   ├── getting-started/
│   │   ├── concepts/
│   │   ├── backends/
│   │   └── reference/
│   ├── content.config.ts   # Starlight docs collection
│   └── styles/custom.css   # brand accent colors
└── public/favicon.svg
```

Content is authored in the Starlight docs collection. Several backend pages are
adapted from the canonical docs under the repo's top-level `docs/`; when those
change, update the mirrored pages here too.

## Deploy

The site is fully static. Any static host works — GitHub Pages, Cloudflare Pages,
Netlify, Vercel. Build with `bun run build` and serve `./dist/`.

Before deploying, set the production URL in `astro.config.mjs` (`site`, and
`base` if hosting under a sub-path such as GitHub Pages at `/afk`).
