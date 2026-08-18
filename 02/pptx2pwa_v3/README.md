# Slides → PWA

Turn a `.pptx` deck or a plain text brief into a single HTML **slide deck**
(one slide fills the screen at a time, navigable with arrow keys, on-screen
arrows, dot indicators, or swipe on touch) — installable as a PWA, generated
by Claude using **your own** Anthropic API key.

## What it does

1. You upload a `.pptx` (its text is auto-extracted into one editable "section" per slide) **or** paste raw text/instructions.
2. You pick a design direction (blank / minimal / bold / playful / dark) and optionally add brand notes.
3. You start with one section and use **+ Add section** to add more — each becomes one full-screen slide in the final deck.
4. Click **Generate landing page** — Claude designs each slide, and the app then deterministically injects a tested navigation system around them (this part is not left up to the model, so it's reliable regardless of what Claude writes): prev/next arrow buttons, dot indicators, a slide counter, ← → ↑ ↓ / Home / End keyboard support, and touch swipe. The result renders live in an iframe.
5. Click **Download PWA (.zip)** to get `index.html` + `manifest.json` + `sw.js` + icons, ready to host anywhere (Netlify, GitHub Pages, S3, your own server) or open locally.

## Setup

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

## Your API key

- Get one at https://console.anthropic.com (Settings → API Keys).
- Paste it into the app. It's kept in your browser's `localStorage` (toggle "Remember on this device" off if you don't want that) and is sent only to your own local server on this machine, which forwards it directly to `api.anthropic.com`. It is never written to disk on the server and never leaves your machine except to reach Anthropic.
- You're billed by Anthropic per API call at standard token rates for whichever model you pick in step 05 (Sonnet 5 is the default and a good balance of quality/cost; Opus 4.8 for max quality, Haiku 4.5 for speed/cost).

## Troubleshooting: "fetch failed"

This means your local server (the Node process from `npm start`) could not reach `api.anthropic.com` at all — it's a network problem on your machine, not a bug in your key or your content. As of this version, the error message includes the real cause in parentheses (e.g. `ENOTFOUND`, `ECONNREFUSED`, a TLS/certificate error) — check what it says first, then match it below:

1. **`ENOTFOUND`** — DNS can't resolve `api.anthropic.com`. Try `ping api.anthropic.com` in a terminal. If that fails too, it's your network/DNS, not the app (try a different DNS, e.g. 1.1.1.1, or a different network).
2. **`ECONNREFUSED` / `ETIMEDOUT`** — Something is actively blocking the connection: a firewall, antivirus, or corporate network policy blocking outbound HTTPS on this machine.
3. **You're on a work/corporate laptop or VPN** — this is the most common cause. Corporate networks often route all traffic through a proxy that Node doesn't use automatically. Fix: find your proxy address (ask IT, or check your OS network settings for "Proxy") and start the server with it set, e.g.:
   ```bash
   HTTPS_PROXY=http://your-proxy-host:port npm start
   ```
   (This version already includes proxy support — it'll auto-detect the `HTTPS_PROXY`/`HTTP_PROXY` env var and route through it.)
4. **Certificate/TLS error** — a corporate MITM proxy or antivirus intercepting HTTPS can break Node's cert validation. Ask IT for the corporate root CA and point Node at it via `NODE_EXTRA_CA_CERTS=/path/to/ca.pem npm start`.
5. **Quick sanity check** — run this in a terminal on the same machine:
   ```bash
   curl -v https://api.anthropic.com
   ```
   If `curl` also fails to connect, it confirms the issue is network-level, not the app. If `curl` succeeds but the app still fails, share the exact error text from the app (it now shows the real cause) — that pinpoints it further.
6. Also confirm you're on **Node 18+** (`node -v`) — older Node versions don't have `fetch` built in and will fail differently, but it's worth ruling out.

## Notes on the PPTX parser

It reads text runs directly out of the slide XML (title + body placeholders), so it works on any standard `.pptx` without needing PowerPoint installed. It does **not** currently pull in images from the deck — describe any imagery you want in the "Extra direction" field or a section's content, and Claude will express it as inline SVG/CSS instead (external image URLs are deliberately avoided so the exported page has no broken-link risk).

## Project structure

```
server.js          Express backend: pptx parsing, Claude proxy, slideshow assembly, PWA zip export
public/index.html  Builder UI
public/app.js       Builder UI logic
public/styles.css   Builder UI styles
```

## How slide navigation works

Claude is prompted to output each slide as `<section class="slide">` inside a `<div id="slides">` wrapper and told **not** to write its own navigation. After Claude responds, `assembleSlideshow()` in `server.js` scans for that structure and injects a fixed, tested navigation layer (CSS transform-based transitions, prev/next buttons, dot indicators, a counter, keyboard and swipe support) deterministically — this part doesn't depend on the model getting the JS right. If Claude ever ignores the structural contract, the whole page falls back to being treated as a single slide rather than breaking.

To change the transition style, timing, or add new keyboard shortcuts, edit `SLIDE_LAYOUT_CSS` and `buildNavBlock()` in `server.js`.

## Customizing the generated design

The design brief sent to Claude lives in `buildPrompt()` in `server.js` — edit the
`templateGuides` object there to change what each template option means, or add
new ones (remember to add a matching `<option>` in `public/index.html`).
