# Threadnote brand assets

The approved **Continuum** mark combines a straight lowercase `t` with a flowing `n` and an extended horizontal tail.
Use the supplied geometry unchanged. Keep its square canvas and internal spacing when scaling or applying a circular
crop. Do not stretch, trim, redraw, or replace the lettering with a similar font.

## Formats and colors

The 12 SVGs cover three shapes—`naked` (transparent), `rounded-square`, and `circle`—in four palettes:

| Palette          | Symbol             | Container / avatar background |
| ---------------- | ------------------ | ----------------------------- |
| Monochrome light | Charcoal `#182124` | White `#ffffff`               |
| Monochrome dark  | White `#ffffff`    | Charcoal `#182124`            |
| Brand light      | Charcoal `#182124` | Mint `#67e8c7`                |
| Brand dark       | Mint `#67e8c7`     | Dark charcoal `#141b1e`       |

Light and dark name the intended background. Naked SVGs have no background; the two light naked variants intentionally
share the same charcoal symbol. For a neutral light surface, use naked brand light or monochrome light. Use brand dark
for the dark website and favicon. Each SVG has a 256 × 256 viewBox and contains only self-contained vector geometry.

## Where to find them

- Source and runtime mark: `assets/brand/threadnote-logo.svg` (naked brand dark).
- SVG variants: `assets/brand/continuum/` in the repository; `svg/` in the download.
- Matching 1024 px PNGs: `website/public/brand/png/`; `png/` in the download.
- Social avatars: `website/public/brand/avatars/`; `avatars/` in the download, at 512 and 1024 px.
- Preview and ZIP: `website/public/brand/overview.png` and `website/public/brand/threadnote-brand-kit.zip`.
- Website favicon: `website/public/favicon.svg`, identical to the brand-dark circle variant; PNG-backed ICO fallback.
- Apple touch icon: 180 px with a solid background so the device can apply its own mask.
- Cursor Marketplace: the brand-dark rounded square at `cursor-plugin/assets/logo.svg`.

For profile uploads, start with `threadnote-avatar-brand-dark-1024.png`. Avatar PNGs have a solid, full-square background;
the entire mark fits inside an inscribed circle, so platforms can crop it without clipping the symbol or leaving
transparent corners. The shaped PNG exports are available when a pre-shaped image is specifically needed.

## Regeneration and geometry

Run `bun run site:brand` after installing the pinned dependencies. It regenerates the variants, PNGs, favicon, Cursor
logo, website copy, Open Graph image, preview, and ZIP from the canonical mark. These are presentation assets; generation
is separate from the runtime and website build.

The path retains the approved 36-unit stroke, `.86` scale, and `translate(-134 -128)` centering. The n terminal ends at
`x238`, extending 22 units beyond the right stem. The symbol has approximately 13.15 units of radial clearance inside
the 128-unit-radius circle. Keep the same placement across all shapes. Check both light and dark renders at 16, 24,
and 32 px after any geometry change.

`threadnote-wordmark.svg` preserves the custom outlined lettering from the approved exploration for the website's
social card. It uses even-odd fill for the letter counters and has no font dependency. The website navigation continues
to use its existing text treatment alongside the new mark.
