# Landing Page Refactor Plan

## Design Principles (2026 Best Practices)
1. **Story-driven hero** — show the before→after arc in first fold
2. **Micro animations with purpose** — minimal motion that adds meaning, not noise (NO 1.45x scale hovers)
3. **Immersive product preview** — terminal demo should be prominent, not buried
4. **Social proof early** — trust signals above the fold or right after hero
5. **Clear pricing** — even "Free & Open Source" is better than nothing
6. **Benefit-driven CTAs** — not "Get Started" but "Start Automating Tests"
7. **Consistent design system** — same patterns across landing, how-it-works, docs

## Changes Required

### 🔴 Critical Fixes
- [ ] Fix ALL `scale: 1.45` hover effects → `scale: 1.02` max
- [ ] Update metadataBase URL from GitHub Pages to `https://triqual.dev`
- [ ] Update version badge from v1.3.0 to v1.4.0
- [ ] Add proper og:image for social sharing

### 🟡 Landing Page Restructure
Current flow: Hero → Trinity Diagram → Feature Panels → Terminal Demo → CTA
New flow: Hero → Social Proof Bar → Terminal Demo → Feature Panels → Pricing → CTA

- [ ] **Hero**: Add "Built for QA engineers using Claude Code" qualifier line
- [ ] **Hero**: Replace diagram image with embedded terminal preview or video placeholder
- [ ] **Social Proof Bar**: New component — GitHub stars, "Open Source", "5 Opus 4.5 Agents", install count
- [ ] **Terminal Demo**: Move UP — this is the money shot, should be section 2 or 3
- [ ] **Feature Panels**: Keep but fix hover scales
- [ ] **NEW: Pricing Section**: Free tier + Pro teaser + Team teaser
- [ ] **NEW: "Who is this for"**: One-liner section targeting QA engineers + Claude Code devs
- [ ] **CTA**: Add video embed placeholder, update copy
- [ ] **Footer**: Add GitHub, Twitter/X, email links, copyright

### 🟢 How It Works Page
- [ ] Ensure consistent styling with landing page
- [ ] Fix any hover scale issues
- [ ] Add breadcrumb navigation

### 🔵 Docs Page
- [ ] Consistent header/nav
- [ ] Same footer as landing

### 🎨 Design Tokens
- [ ] Audit globals.css for consistent spacing, colors
- [ ] Ensure dark theme is cohesive across all pages
