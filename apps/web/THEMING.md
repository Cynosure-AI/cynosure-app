# Web theme contract

Each file in `apps/web/src/assets/themes/` defines one palette on the document root. Theme files contain values; they do not select Tailwind utilities or individual components. `main.css` registers the colors with Tailwind, `theme-effects.css` applies optional component surface and action effects, and `theme-decorations.css` holds artwork such as scan lines and corner brackets.

Use these Tailwind colors in components:

| Intent | Utility examples | Token source |
| --- | --- | --- |
| Canvas, panels, and raised surfaces | `bg-theme-950`, `bg-theme-900`, `bg-theme-800` | `--color-theme-*` |
| Primary and secondary text | `text-theme-100`, `text-theme-300` | `--color-theme-*` |
| Small text, icons, placeholders | `text-ink-secondary`, `text-ink-muted`, `text-ink-faint` | `--color-ink-*` |
| Links and accent text | `text-accent-fg` | `--color-accent-fg` |
| Text on accent fills | `text-accent-on` | `--color-accent-on` |
| Status text | `text-status-success`, `text-status-warning`, etc. | `--color-status-*` |
| Rendered quote and code surfaces | shared markdown CSS | `--color-quote-surface`, `--color-code-surface` |

Use `accent-action` on a primary filled control when it should receive the theme's optional gradient or shadow. Its fill and text still come from normal Tailwind classes. App shell, content frame, sidebar, and chat composer have explicit component classes for their optional surface effects.

Keep text contrast at 4.5:1 or higher against the raised surface and on both accent fill steps. `theme-contract.test.ts` checks those pairs and enforces one root rule per palette file. Theme specific decorations can be added to `theme-decorations.css` when they cannot be expressed as a color or surface token.
