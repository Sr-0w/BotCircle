# Quiet UI — shared design language (Web and Android)

This is the reference both clients follow. The Android tokens live in
`apps/android/designsystem/src/main/kotlin/app/dot/design/Tokens.kt` (taken from the Dot Mail design system); the Web
tokens live in `apps/web/src/index.css`. **When a value changes, change it in both files and here.** The clients share
an identity, not a layout: each one uses the navigation that suits its screen.

## Principles

- Calm, almost monochrome surfaces. Hierarchy comes from type weight, contrast and spacing, not colour.
- One accent, blue. It marks links, focus, "new", and primary actions. Primary actions are a **solid blue fill with a
  white label**, never glass.
- Three complete themes: Light, Dark and OLED black. OLED is not Dark with a darker page: the page is exactly
  `#000000` and only the surfaces that must read as separate are lifted.
- Glass and blur are rare: a real, progressive backdrop blur on the **top edge** of a scrolling surface, and a few
  floating controls. No blur at the bottom, no tinted band, no flicker. The composer sits on a stable surface.
- Motion is short and useful, and honours "reduce motion". Transparency honours "reduce transparency".
- Work (reasoning, tool calls) stays out of the conversation; the thread shows messages, files and cards.

## Colour

| Token (Android / Web) | Light | Dark | OLED |
|---|---|---|---|
| `background` / `--background` | `#FFFFFF` | `#0D0D0E` | `#000000` |
| `surface` / `--card`, `--muted`, `--popover` | `#F6F6F7` (cards stay `#FFFFFF` on Web) | `#161618` | `#111113` |
| `surfaceRaised` / `--accent`, `--secondary` | `#EDEDEF` | `#202023` | `#1B1B1E` |
| `border` / `--border` | `#E8E8EB` | `#26262A` | `#242428` |
| `borderStrong` / `--input` | `#D4D4D9` | `#38383D` | `#3A3A40` |
| `textPrimary` / `--foreground` | `#0D0D0E` | `#EDEDEF` | `#EDEDEF` |
| `textSecondary` / `--muted-foreground` | `#5E5E66` | `#A0A0A7` | `#A0A0A7` |
| `textTertiary` / `--tertiary-foreground` | `#6A6A72` | `#82828B` | `#82828B` |
| `accent` / `--link`, `--ring` | `#0057D9` | `#70A7FF` | `#70A7FF` |
| `accentFill` / `--primary` | `#0057D9` | `#245FE6` | `#245FE6` |
| `danger` / `--destructive` | `#D92D33` | `#F2555A` | `#F2555A` |
| `success` / `--success` | `#1E9E63` | `#4CC38A` | `#4CC38A` |

Text tokens meet WCAG AA on `background` and `surface` in every theme.

## Type

Inter everywhere (bundled in both clients), tabular figures where numbers align. Monospace only for code, ids and
model names.

## Geometry and spacing

- Radii: **8 / 12 / 18 px** (small / medium / large); **28 px** for dialogs and sheets; a true pill (50 %) only for
  actions that are pills, not for list rows.
- Spacing scale: 4, 8, 12, 16, 20, 28, 40. Page gutter: 20. Hairlines: 0.5 dp on Android, 1 px on Web.

## Motion

150 ms (fast), 250 ms (medium), 380 ms (slow), decelerating in and accelerating out. With reduced motion, transitions
become fades or are removed.

## Platform notes

- **Android**: full-screen pages behind a bottom bar, no drawer (issue #28). Blur through Haze, top header and
  floating controls only.
- **Web**: sidebar on desktop, a sheet on small screens; settings are a two-pane page on desktop and a list of
  sections then a page on small screens. The top-edge blur is the `.quiet-top-blur` utility.
