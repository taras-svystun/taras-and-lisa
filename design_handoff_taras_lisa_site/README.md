# Handoff: Taras & Lisa Personal Brand Website

## Overview
A 5-page personal brand website for Taras and Lisa, a couple who work together as coaches/instructors (couples coaching, mountain guiding, snowboarding, running/survival, teen mentoring, DJ basics, yoga/breathwork) plus a standalone "IT Portfolio" page for Taras's separate AI/ML engineering consulting work. Warm, adventurous, editorial tone — no corporate/minimalist-cold styling.

## About the Design Files
The files in this bundle are **design references built as static HTML prototypes** (Design Components in the authoring tool used) — they show the intended look, content, and layout, not production code to copy directly. Recreate these designs in the target codebase's existing environment (React, Vue, a static site generator, etc.), following its established component patterns, routing, and build tooling. If no environment exists yet, a simple static site (plain HTML/CSS or a lightweight framework like Astro/Next.js) is a reasonable default given there's no backend and no forms.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, and copy are locked. Recreate pixel-perfectly using the codebase's tooling (inline styles here should become whatever styling approach — CSS modules, Tailwind, styled-components — fits the target repo; values should carry over exactly).

## Screens / Views

### 1. Home (`index.dc.html`)
- **Purpose**: Primary landing page — introduces the couple, teases About/Services, drives to Contact.
- **Layout**: Single column, max-width 1280px centered container, sections stacked vertically full-bleed with alternating backgrounds.
- **Sections, top to bottom**:
  1. **Nav** — logo image (left) + pill-group nav (Home/About/Services/Portfolio/Contact) in a rounded white-ish pill container (`#FFFFFFA0` background, `border-radius:999px`, `padding:6px`), flex-wrap on narrow widths. Active page shown with dark pill (`#22302A` bg, `#FBF7EF` text).
  2. **Hero** — centered column, max-width 820–900px:
     - Eyebrow pill: "Taras & Lisa", bg `#F0E4D0`, text `#8a5a1f`, uppercase, 14px, weight 600, `border-radius:999px`, padding `8px 18px`.
     - H1, Cabinet Grotesk 800, `clamp(32px,5vw,48px)`, line-height 1.2: "Two people who never really stopped **moving**" — the word "moving" only has a hand-drawn amber squiggle underline (inline SVG path, stroke `#E7A335`, width 4, round caps) positioned directly beneath it via `position:relative` wrapper with `white-space:nowrap` (critical: only wrap the last word so the underline never collides with wrapped text).
     - Subhead paragraph, 19px, `#3E4C46`, max-width 600px, centered.
     - Two pill CTAs, centered, gap 16px: "See what we do" (solid amber `#E7A335` bg, dark text) → `/services`; "Say hi" (outline, 2px `#22302A` border, transparent bg) → `/contact`.
     - Below: one large hero photo in an organic rounded-blob mask (`border-radius: 46% 54% 58% 42% / 52% 46% 54% 48%`), `height:min(620px,62vw)`, `object-fit:cover`, drop shadow, with two thin dashed teal/amber decorative curve SVGs peeking out at opposite corners (z-index behind photo).
  3. **About teaser** — sage background (`#E4EBE1`), two-column (photo left ~40%, text right ~60% on desktop, stacks on mobile via flex-wrap), photo in blob mask, heading "About us", one condensed paragraph, pill link "Read our story →" (dark bg) to About page.
  4. **Moments strip** — 3 small photos (200×280px-ish) in organic blob masks, staggered vertical offset (`translateY` alternating ±10–24px), centered row, flex-wrap, with a wavy dashed teal trail-line SVG behind them (absolute, z-index 0).
  5. **Services preview grid** — heading "What we do" + subhead, centered. 7 cards in an **asymmetric staggered layout**: `display:flex; flex-wrap:wrap; gap:24px`, each card `flex: 1 1 <basis%>` (varies per card: 38%/46%/30%/30%/30%/44%/40%) with `min-width:260px` (forces single-column stacking on mobile) and alternating `margin-top` offsets (0/36px/-16px/20px/0/28px/-12px) for a staggered rhythm. A dashed amber/teal wavy trail-line SVG runs behind the whole grid (absolute, z-index 0, cards at z-index 1). Each card: numbered pill badge (01–07, dark circle), title (Cabinet Grotesk 700, 20px), 15px description, links to `/services#<service-id>`. Card backgrounds alternate sage/sand.
  6. **Contact CTA** — sand background (`#F0E4D0`), centered, heading "Let's talk", body copy, one amber pill CTA to `/contact`.
  7. **Footer** — logo (small) + copyright, space-between, top border `1px solid #22302A1A`.

### 2. About (`about.dc.html`)
- Nav (same component, About active).
- Hero: two-column (text left, large blob-masked photo right, ~1.1fr/1fr, stacks on mobile), eyebrow "Our story", H1 "About us", two full paragraphs (exact copy below), no CTA buttons here.
- Secondary photo pair: two photos side by side (280×340px blob masks, one offset `margin-top:32px`), centered, gap 24px, flex-wrap.
- CTA band: sage background, centered, "Curious what that looks like in practice?" + pill link to Services.
- Footer (same as Home).

### 3. Services (`services.dc.html`)
- Nav (Services active).
- Intro: centered, eyebrow "What we do", H1 "Seven things we're good at", subhead.
- One wide banner photo (blob mask, `height:min(420px,48vw)`).
- **Full services list**: vertical stack (not a grid) of 7 rows, each `grid-template-columns: 80px 1fr`, numbered circle (56px) + title (Cabinet Grotesk 700, 26px) + full description (17px), each row has an `id="<service-id>"` anchor target, background alternates sage/sand, `border-radius:32px`, padding 36px.
- CTA band: sand background, "Not sure which one fits?" + amber pill to Contact.
- Footer.

### 4. IT Portfolio (`it-portfolio.dc.html`)
- Nav (Portfolio active) — a 5th nav item added to every page's nav.
- Intro: centered, eyebrow "Also: Taras builds AI systems", H1 "The technical side of Taras", subhead framing this as Taras's separate technical/consulting track.
- **Experience** (sage band): vertical list of 4 roles, each a card (`grid-template-columns: 56px 1fr`) with numbered circle, role/company/period header row, and a bulleted list of achievements (see content below).
- **Projects**: heading "Projects", 4 cards in the same asymmetric staggered flex layout as the homepage services grid (basis 38/46/40/38%, alternating margin-top), each links out to a GitHub/YouTube URL in a new tab, trail-line SVG behind.
- **Education & writing** (sand band): two paragraphs with inline links to a thesis paper/repo/demo and technical-book note repos.
- **CTA**: centered, "Need an AI engineer, not a mountain guide?", two pill buttons — amber solid `mailto:tatarik.sv@gmail.com`, outline link to GitHub profile.
- Footer.

### 5. Contact (`contact.dc.html`)
- Nav (Contact active).
- Full-height centered column (flex column, `flex:1` content area between nav and footer): eyebrow "Get in touch", H1 "Let's talk", body copy, one large amber pill button as a `mailto:` link showing the email address as its label, and a row of two circular social icon buttons (Instagram "IG" / Telegram "TG", dark circles) — **currently rendered conditionally and hidden because no real URLs exist yet** (empty string props); wire up real URLs before launch and they'll appear automatically.
- Footer.
- Decorative dashed teal squiggle SVG behind the heading.

## Interactions & Behavior
- All navigation is plain in-site links between the 5 static pages (no client-side routing framework required, but fine to use one).
- No forms, no backend. Contact is `mailto:` only — this is intentional (approved as the MVP).
- No animations beyond CSS; hover states on links/buttons should darken/shift per the design system's link hover rule (see Design Tokens).
- Social icons on Contact are placeholders: keep them hidden until real Instagram/Telegram URLs are supplied — do not fabricate URLs.

## State Management
None — fully static content, no client state, no data fetching.

## Design Tokens

**Colors**
- Ivory background: `#FBF7EF`
- Ink (text): `#22302A`
- Body copy (secondary ink): `#3E4C46`
- Amber (primary accent): `#E7A335`
- Alpine teal (secondary accent): `#2F6E63`
- Sage (alt section bg): `#E4EBE1`
- Sand (alt section bg): `#F0E4D0`
- Eyebrow-pill text: `#8a5a1f` (a darker amber-brown for legibility on sand pills)
- Link default: teal `#2F6E63`; link hover: amber `#E7A335`

**Typography**
- Display font: **Cabinet Grotesk** (weights 500/700/800 used) — headings.
- Body font: **General Sans** (weights 400/500/600 used) — body copy, nav, buttons.
- Loaded via Fontshare: `https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@800,700,500&f[]=general-sans@400,500,600&display=swap`
- Scale: H1 ranges `clamp(30px,4.5vw,48px)` to fixed 48px depending on page; H2 ~30–36px; body 15–19px; nav/buttons 15–16px.

**Shape language**
- No sharp corners anywhere. Buttons/pills: `border-radius:999px`.
- Photo masks: organic asymmetric blob radii, e.g. `46% 54% 58% 42% / 52% 46% 54% 48%` (values vary slightly per photo for organic variety — not a single reusable constant).
- Cards/panels: `border-radius:28–32px`.

**Trail-line motif**
- A recurring dashed curved-line SVG (`stroke-dasharray:"2 12"` to `"2 14"`, `stroke-linecap:round`, opacity 0.4–0.5, color teal or amber) used as a section divider and as a decorative element running behind card grids and photo clusters. Treat as a reusable decorative component parameterized by a bezier path string and color.

**Spacing**
- Page container max-width: 1280px (900/820 for narrower centered hero/copy blocks).
- Section vertical padding: ~70–90px desktop.
- Card/grid gap: 24px.

**Responsive behavior**
- No media queries used in the prototype — responsiveness comes from `flex-wrap:wrap` + per-item `min-width` (forces single-column stacking below ~600–700px) and `clamp()` for fluid type/photo sizing. A production rebuild is free to use real breakpoints instead, but should preserve: nav wraps to two rows on narrow screens, hero goes single-column, all card grids stack to one column.

## Assets
- `uploads/taras_and_lisa_logo_draft.png` — logo lockup (mountain mark + wordmark + Ukrainian tagline), transparent background. User-provided, used as-is in nav (46px tall) and footer (32px tall).
- `uploads/our-photo.jpg` — primary hero/about photo (stone-wall embrace). User-provided. Alt text used verbatim: "Taras and Lisa on a hiking trail".
- `uploads/our-photo_2.jpg` through `uploads/our-photo_6.jpg` — additional couple photos (rooftop hug, sunset selfie, night snowboarding, ski-lift group, ski-lift selfie) used across Home's moments strip, About's photo pair, and Services' banner. User-provided.

## Exact Copy

**Hero**
- Eyebrow: `Taras & Lisa`
- Headline: `Two people who never really stopped moving`
- Subhead: `We've hitchhiked more countries than we can count, tried nearly every sport that looked fun, and somewhere along the way turned all of it into things we teach. Couples coaching. Mountain guiding. Snowboarding. A few other things too.`
- CTAs: `See what we do` (→ /services), `Say hi` (→ /contact)

**About**
- Heading: `About us`
- Para 1: `We're Taras and Lisa — partners in life, and partners in whatever's next. We got together over a shared love of moving through the world with as little planning as possible: hitchhiking across countries with no fixed route, saying yes to sports we'd never tried, and collecting friends everywhere we stopped.`
- Para 2: `That restlessness turned out to be useful. We spend our days now teaching the things we picked up along the way — how to communicate like adults, how to read a mountain, how to fall down a slope with less damage, how to keep moving when things get hard. We're still doing all of it together.`

**Services** (id / title / description — used both in the homepage preview cards, shortened, and in full on the Services page)
1. `couples-coaching` / Couples Coaching / "We work with couples on the things that actually break relationships: communication, emotional patterns, and the small stuff that becomes big stuff. Grounded in psychology, not platitudes."
2. `mountain-guiding` / Mountain Guiding / "Guided treks and hikes for people who want to get into the mountains safely — whether that's your first summit or your fiftieth."
3. `snowboard-lessons` / Snowboard Lessons / "Private snowboard instruction for beginners through intermediate riders. We'll get you off the beginner slope faster than you think."
4. `running-survival` / Running & Outdoor Survival / "Trail running coaching paired with the basics of outdoor survival — because running far means less if you don't know what to do once you're actually out there."
5. `teen-mentoring` / Mentoring for Teens & Young Adults / "Coaching and mentorship for teen camps and youth groups — we've been the adults kids actually listen to."
6. `dj-basics` / DJ Basics / "A hands-on introduction to DJing for complete beginners. No prior music experience needed, just curiosity."
7. `yoga-breathwork` / Yoga & Breathwork / "Foundational yoga and breathing practice for people who want to slow down without turning it into a whole lifestyle."

**Contact**
- Heading: `Let's talk`
- Body: `Tell us what you're after — a session, a lesson, a trek, or something in between — and we'll get back to you.`
- Email (placeholder — replace before launch): `hello@taras-and-lisa.com`
- Social: Instagram/Telegram — left empty/hidden until real URLs exist.

**IT Portfolio** — full experience/project/education copy is authored directly in `it-portfolio.dc.html`; see that file for the exact text (it's long-form and easiest to read in place).

## Files
All in the project root, self-contained (each opens standalone in a browser):
- `index.dc.html` — Home
- `about.dc.html` — About
- `services.dc.html` — Services
- `it-portfolio.dc.html` — IT Portfolio
- `contact.dc.html` — Contact
- `uploads/` — all photo and logo assets referenced above

Note: these `.dc.html` files use a proprietary templating syntax (`{{ }}` holes, `<sc-for>` loops) from the design tool they were authored in — **do not copy that syntax into the target codebase**. Treat them purely as rendered reference (open in a browser to see the real output) plus the copy/structure/token documentation above.
