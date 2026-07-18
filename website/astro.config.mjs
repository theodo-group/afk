// @ts-check
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"
import mermaid from "astro-mermaid"

// https://astro.build/config
export default defineConfig({
  // GitHub Pages project site: served at https://theodo-group.github.io/afk/.
  // Internal links in content must carry the /afk prefix; dev mode serves
  // under /afk/ too, so links behave identically locally and deployed.
  site: "https://theodo-group.github.io",
  base: "/afk",
  integrations: [
    mermaid({
      autoTheme: true,
      iconPacks: [
        { name: "logos", url: "https://unpkg.com/@iconify-json/logos@1/icons.json" },
        { name: "lucide", url: "https://unpkg.com/@iconify-json/lucide@1/icons.json" },
      ],
    }),
    starlight({
      title: "AFK",
      description:
        "Run ephemeral containerized tasks in the cloud from a CLI. Built for AI agents that work while you're away from keyboard.",
      logo: {
        src: "./src/assets/logo.svg",
        replacesTitle: false,
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/theodo-group/afk",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/theodo-group/afk/edit/main/website/",
      },
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "How it works", slug: "getting-started/how-it-works" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Quickstart", slug: "getting-started/quickstart" },
          ],
        },
        {
          label: "Concepts",
          items: [{ label: "Glossary", slug: "concepts/glossary" }],
        },
        {
          label: "Backends",
          items: [
            { label: "Overview", slug: "backends/overview" },
            { label: "AWS EC2", slug: "backends/aws" },
            { label: "GCP Compute Engine", slug: "backends/gcp" },
            { label: "Cloudflare Containers", slug: "backends/cloudflare" },
            { label: "Local", slug: "backends/local" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI surface", slug: "reference/cli" },
            { label: "Configuration", slug: "reference/configuration" },
            { label: "Consumer contract", slug: "reference/consumer-contract" },
          ],
        },
      ],
    }),
  ],
})
