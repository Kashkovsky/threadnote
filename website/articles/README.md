# Website articles

Authored articles on Threadnote’s “What’s New” timeline live here as Markdown. Each article uses this contract:

```md
---
author: Denys Kashkovskyi
publishedAt: 2026-08-26T14:30:00Z
slug: evidence-before-rewrites
summary: A concise, standalone description for cards, search results, and social previews.
title: Evidence before rewrites
---

Article body in Markdown.
```

Name the file `2026-08-26T14-30-00Z--evidence-before-rewrites.md`. The filename timestamp and slug must exactly match
the frontmatter. This makes chronology reviewable in the repository while the explicit slug remains the stable public
URL at `/whats-new/articles/evidence-before-rewrites/`.

`author`, `publishedAt`, `slug`, `summary`, and `title` are required. `authorUrl` is optional and must be a
credential-free HTTPS URL. The site build rejects duplicate slugs, invalid timestamps, unknown frontmatter fields, and
empty bodies. It emits crawler-readable HTML, canonical and social metadata, Article JSON-LD, and sitemap entries for
every valid article.
