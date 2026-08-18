// server.js — Slides→PWA backend
// Serves the frontend and proxies calls to the Anthropic API using a key
// the user supplies in the browser (never stored on disk unless the user
// explicitly saves it to a local .env — see README).

const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const archiver = require('archiver');
const path = require('path');

// Node's built-in fetch does NOT read HTTP_PROXY/HTTPS_PROXY env vars on its
// own — on a corporate network that's usually why outbound calls fail with a
// bare "fetch failed". If a proxy env var is set, route fetch through it.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`Routing outbound requests through proxy: ${proxyUrl}`);
  } catch (e) {
    console.warn('HTTPS_PROXY/HTTP_PROXY is set but the "undici" package is not installed. Run "npm install undici" to enable proxy support.');
  }
}

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// ---------- Helpers ----------

// Extract plain text runs from a slideN.xml body, in document order,
// grouping by paragraph so bullet structure survives.
function extractTextFromSlideXml(xml) {
  const paragraphs = [];
  const paraRegex = /<a:p>([\s\S]*?)<\/a:p>/g;
  let pMatch;
  while ((pMatch = paraRegex.exec(xml)) !== null) {
    const paraXml = pMatch[1];
    const runRegex = /<a:t>([\s\S]*?)<\/a:t>/g;
    let runMatch;
    let text = '';
    while ((runMatch = runRegex.exec(paraXml)) !== null) {
      text += runMatch[1];
    }
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

function parsePptxBuffer(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const slideEntries = entries
    .filter(e => /^ppt\/slides\/slide(\d+)\.xml$/.test(e.entryName))
    .map(e => ({
      index: parseInt(e.entryName.match(/slide(\d+)\.xml/)[1], 10),
      xml: e.getData().toString('utf8'),
    }))
    .sort((a, b) => a.index - b.index);

  if (slideEntries.length === 0) {
    throw new Error('No slides found — is this a valid .pptx file?');
  }

  return slideEntries.map((s, i) => {
    const paragraphs = extractTextFromSlideXml(s.xml);
    const title = paragraphs[0] || `Slide ${i + 1}`;
    const body = paragraphs.slice(1).join('\n');
    return { title, content: body };
  });
}

function buildPrompt({ template, brand, slides, sourceText }) {
  const slidesBlock = slides
    .map(
      (s, i) => `--- Slide ${i + 1} ---
Title: ${s.title || '(untitled)'}
Content:
${s.content || '(no content provided — invent something reasonable that fits the title and overall narrative)'}`
    )
    .join('\n\n');

  const templateGuides = {
    blank: 'No visual direction has been set. Invent a coherent, distinctive design system (palette, type pairing, layout) that fits the subject matter of the content itself — do not fall back on generic AI-page defaults (cream+terracotta, near-black+neon accent, or a hairline-rule broadsheet grid) unless the content genuinely calls for it.',
    minimal: 'Minimal, editorial, lots of whitespace, restrained single accent color, precise spacing and type scale over decoration.',
    bold: 'High contrast, large confident type, one saturated signature color, strong section rhythm, a bit of motion on hover/enter.',
    playful: 'Warm and approachable, rounded shapes okay, illustrative accents, friendly voice, light delightful micro-interactions.',
    dark: 'Dark-mode-first, moody, a single glowing accent color, technical/product feel, monospace touches for data or labels.',
  };

  return `You are building a single self-contained HTML document that behaves like a PRESENTATION DECK viewed in a browser (and installable as a PWA) — one slide fills the screen at a time, and the person moves between slides with arrows/swipe/keyboard. You will output ONE complete HTML document — no markdown fences, no commentary, just the raw HTML starting with <!DOCTYPE html>.

DESIGN DIRECTION: ${templateGuides[template] || templateGuides.blank}
${brand ? `BRAND / EXTRA INSTRUCTIONS FROM THE USER: ${brand}` : ''}

CONTENT: build exactly ${slides.length} slide(s) from the material below, in this order. Each becomes one full-screen slide — treat each like a real presentation slide: a strong focal point, not a dense scrolling page crammed in. Preserve the actual meaning and facts; you may tighten or restyle the copy but do not invent facts that contradict the source.

${slidesBlock}

${sourceText ? `RAW SOURCE TEXT (extra context/instructions, use alongside the slides above):\n${sourceText}\n` : ''}

MANDATORY STRUCTURAL CONTRACT (the app injects navigation around this automatically — follow it exactly or navigation will break):
- Inside <body>, the ONLY top-level content must be a single wrapper: <div id="slides"> ... </div>
- Inside that wrapper, exactly ${slides.length} direct children, each: <section class="slide"> ... </section> — one per slide above, in order. Do not nest a .slide inside another .slide, and do not add any other top-level elements alongside #slides.
- Each .slide is a complete, self-contained visual composition for that one slide (its own background, layout, typography) — do not design it as a chunk of a long scrolling page. Assume it fills the viewport.
- Do NOT add your own navigation arrows, dot indicators, "next/prev" buttons, scroll-snap, or slide-changing JavaScript — the app injects a shared, working navigation system after generation. Any nav you add yourself will be redundant or may conflict.
- Do NOT rely on scroll position for anything (no scroll-snap, no scroll-linked animation) since navigation is not scroll-based.
- If a slide's content is long, let it scroll internally within that .slide (the app makes each .slide independently scrollable) rather than shrinking type to fit.

TECHNICAL REQUIREMENTS:
- All CSS in a <style> tag in <head>. Optional small vanilla JS before </body> for in-slide effects only (e.g. an entrance animation) — never for changing which slide is shown. No external CSS/JS libraries or CDN fetches, other than an optional Google Fonts <link> if it fits the type direction.
- Add these PWA-related tags in <head>: <meta name="viewport" content="width=device-width, initial-scale=1">, <meta name="theme-color" content="[your accent hex]">, <link rel="manifest" href="manifest.json">.
- Fully responsive down to a 360px-wide phone. Visible keyboard focus states. Respect prefers-reduced-motion.
- Semantic HTML, real heading hierarchy, alt text on any decorative SVG/icons you draw inline.
- Do not include actual <img> tags pointing at external URLs (no placeholder image services) — if you want imagery, draw it with inline SVG/CSS instead.
- Follow the design-principles of a distinctive, opinionated design studio: pick a real palette (4–6 named hex values, defined as CSS custom properties on :root so the injected nav controls can borrow your accent color), a deliberate type pairing, a clear layout concept per slide, and one signature visual element carried through the deck.

Output only the raw HTML document.`;
}

// ---------- Slideshow assembly (deterministic — not left to the model) ----------
// Finds the model's <div id="slides">...</div> block and injects a tested,
// reliable navigation system (arrows, dots, counter, keyboard, swipe) around
// it. If the model didn't follow the structural contract, falls back to
// treating the whole body as one slide rather than failing outright.

function findMatchingClose(html, openTagStartIdx, tagName) {
  const tagRe = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}>`, 'gi');
  tagRe.lastIndex = openTagStartIdx;
  let depth = 0;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    if (match[0][1] === '/') {
      depth--;
      if (depth === 0) return { start: openTagStartIdx, end: match.index + match[0].length };
    } else {
      depth++;
    }
  }
  return null;
}

const SLIDE_LAYOUT_CSS = `<style id="slideshow-layout">
  html, body { margin:0; padding:0; height:100%; overflow:hidden; }
  #slides { display:flex; height:100dvh; width:100dvw; transition: transform .55s cubic-bezier(.65,0,.35,1); will-change:transform; }
  @media (prefers-reduced-motion: reduce) { #slides { transition:none; } }
  #slides > .slide { flex:0 0 100dvw; width:100dvw; height:100dvh; overflow-y:auto; }
  #slideshow-nav-prev, #slideshow-nav-next {
    position:fixed; top:50%; transform:translateY(-50%); z-index:1000;
    width:44px; height:44px; border-radius:50%; border:none; cursor:pointer;
    background:rgba(0,0,0,.35); color:#fff; font-size:20px; line-height:1;
    display:flex; align-items:center; justify-content:center; backdrop-filter:blur(4px);
  }
  #slideshow-nav-prev:hover, #slideshow-nav-next:hover { background:rgba(0,0,0,.55); }
  #slideshow-nav-prev:disabled, #slideshow-nav-next:disabled { opacity:.25; cursor:default; }
  #slideshow-nav-prev { left:16px; } #slideshow-nav-next { right:16px; }
  #slideshow-dots { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); z-index:1000; display:flex; gap:8px; }
  #slideshow-dots button { width:8px; height:8px; border-radius:50%; border:none; padding:0; background:rgba(0,0,0,.25); cursor:pointer; }
  #slideshow-dots button[aria-current="true"] { background:rgba(0,0,0,.75); width:22px; border-radius:5px; }
  #slideshow-counter { position:fixed; top:16px; right:16px; z-index:1000; font:12px/1 monospace; background:rgba(0,0,0,.35); color:#fff; padding:6px 10px; border-radius:20px; backdrop-filter:blur(4px); }
  @media (max-width:640px){ #slideshow-nav-prev,#slideshow-nav-next{width:38px;height:38px;font-size:16px;} }
</style>`;

function buildNavBlock(count) {
  const dots = Array.from({ length: count }, (_, i) =>
    `<button aria-label="Go to slide ${i + 1}" aria-current="${i === 0}" data-i="${i}"></button>`
  ).join('');

  return `
<button id="slideshow-nav-prev" aria-label="Previous slide" disabled>&#8249;</button>
<button id="slideshow-nav-next" aria-label="Next slide">&#8250;</button>
<div id="slideshow-dots">${dots}</div>
<div id="slideshow-counter">1 / ${count}</div>
<script id="slideshow-nav">
(function(){
  var slides = ${count};
  var track = document.getElementById('slides');
  var i = 0;
  var prev = document.getElementById('slideshow-nav-prev');
  var next = document.getElementById('slideshow-nav-next');
  var dots = Array.prototype.slice.call(document.querySelectorAll('#slideshow-dots button'));
  var counter = document.getElementById('slideshow-counter');

  function render(){
    if (track) track.style.transform = 'translateX(-' + (i * 100) + 'dvw)';
    if (prev) prev.disabled = (i === 0);
    if (next) next.disabled = (i === slides - 1);
    dots.forEach(function(d, idx){ d.setAttribute('aria-current', idx === i ? 'true' : 'false'); });
    if (counter) counter.textContent = (i + 1) + ' / ' + slides;
  }
  function go(n){ i = Math.max(0, Math.min(slides - 1, n)); render(); }

  if (prev) prev.addEventListener('click', function(){ go(i - 1); });
  if (next) next.addEventListener('click', function(){ go(i + 1); });
  dots.forEach(function(d){ d.addEventListener('click', function(){ go(parseInt(d.dataset.i, 10)); }); });

  document.addEventListener('keydown', function(e){
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') { go(i + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { go(i - 1); }
    else if (e.key === 'Home') { go(0); }
    else if (e.key === 'End') { go(slides - 1); }
  });

  var touchStartX = null;
  document.addEventListener('touchstart', function(e){ touchStartX = e.touches[0].clientX; }, { passive: true });
  document.addEventListener('touchend', function(e){
    if (touchStartX === null) return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) { go(dx < 0 ? i + 1 : i - 1); }
    touchStartX = null;
  }, { passive: true });

  render();
})();
</script>`;
}

function assembleSlideshow(html) {
  let slideCount = 0;

  const openMatch = /<div\s+id=["']slides["'][^>]*>/i.exec(html);
  if (openMatch) {
    const range = findMatchingClose(html, openMatch.index, 'div');
    if (range) {
      const openTagEnd = openMatch.index + openMatch[0].length;
      const closeTagStart = range.end - '</div>'.length;
      const inner = html.slice(openTagEnd, closeTagStart);
      slideCount = (inner.match(/<section\b/gi) || []).length;
    }
  }

  if (!slideCount) {
    // Model didn't follow the contract — fall back to one slide so the
    // export still works, rather than erroring out on the user.
    const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    if (!bodyMatch) throw new Error('The model did not return a valid HTML document — try again.');
    const wrapped = `<div id="slides"><section class="slide">${bodyMatch[1]}</section></div>`;
    html = html.replace(bodyMatch[0], `<body>${wrapped}</body>`);
    slideCount = 1;
  }

  html = html.replace(/<\/head>/i, `${SLIDE_LAYOUT_CSS}\n</head>`);
  html = html.replace(/<\/body>/i, `${buildNavBlock(slideCount)}\n</body>`);

  return { html, slideCount };
}

// ---------- Routes ----------

app.post('/api/parse-pptx', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const slides = parsePptxBuffer(req.file.buffer);
    res.json({ slides });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { apiKey, model, template, brand, slides, sourceText } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'Missing Anthropic API key.' });
    if (!Array.isArray(slides) || slides.length === 0) {
      return res.status(400).json({ error: 'At least one slide is required.' });
    }

    const prompt = buildPrompt({ template, brand, slides, sourceText });

    let anthropicRes;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);
      anthropicRes = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: model || 'claude-sonnet-5',
          max_tokens: 16000,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch (networkErr) {
      // Node's fetch collapses DNS/TLS/proxy/connection failures into a bare
      // "fetch failed" — the real reason lives on .cause. Surface it so the
      // user can actually diagnose (ENOTFOUND, ECONNREFUSED, cert error, etc).
      const cause = networkErr.cause ? ` (${networkErr.cause.code || networkErr.cause.message || networkErr.cause})` : '';
      const isAbort = networkErr.name === 'AbortError';
      console.error('Anthropic request failed:', networkErr);
      return res.status(502).json({
        error: isAbort
          ? 'Request to Anthropic timed out after 90s. Check your network connection.'
          : `Could not reach api.anthropic.com${cause}. This is usually a network/firewall/proxy/VPN issue on this machine, not the app — see README "Troubleshooting: fetch failed".`,
      });
    }

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      return res.status(anthropicRes.status).json({ error: data?.error?.message || 'Anthropic API error.' });
    }

    const textBlock = (data.content || []).find(b => b.type === 'text');
    let html = textBlock ? textBlock.text : '';
    html = html.trim().replace(/^```(?:html)?/i, '').replace(/```$/, '').trim();

    if (!html.toLowerCase().includes('<!doctype')) {
      return res.status(502).json({ error: 'Model did not return a full HTML document. Try again.' });
    }

    const { html: assembledHtml, slideCount } = assembleSlideshow(html);

    res.json({ html: assembledHtml, slideCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error.' });
  }
});

app.post('/api/download', (req, res) => {
  try {
    const { html, appName } = req.body;
    if (!html) return res.status(400).json({ error: 'No HTML to package.' });

    const name = (appName || 'My Landing Page').slice(0, 60);
    const shortName = name.slice(0, 20);

    // Pull the theme-color meta if present, else default.
    const themeMatch = html.match(/name="theme-color"\s+content="(#[0-9a-fA-F]{3,8})"/);
    const themeColor = themeMatch ? themeMatch[1] : '#111111';

    const manifest = {
      name,
      short_name: shortName,
      start_url: './index.html',
      display: 'standalone',
      background_color: themeColor,
      theme_color: themeColor,
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    };

    const swJs = `const CACHE = 'app-cache-v1';
const ASSETS = ['./', './index.html', './manifest.json'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});`;

    // Register the service worker + link icons inside the HTML if not already present.
    let finalHtml = html;
    if (!finalHtml.includes('serviceWorker')) {
      finalHtml = finalHtml.replace(
        '</body>',
        `<script>if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));}</script>\n</body>`
      );
    }
    if (!finalHtml.includes('rel="icon"')) {
      finalHtml = finalHtml.replace('</head>', `<link rel="icon" href="icon-192.png">\n</head>`);
    }

    // Simple flat-color PNG icons generated on the fly (no external deps: raw PNG bytes).
    const icon192 = makeSolidPng(themeColor, 192, 192);
    const icon512 = makeSolidPng(themeColor, 512, 512);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="landing-page-pwa.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    archive.append(finalHtml, { name: 'index.html' });
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    archive.append(swJs, { name: 'sw.js' });
    archive.append(icon192, { name: 'icon-192.png' });
    archive.append(icon512, { name: 'icon-512.png' });
    archive.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error.' });
  }
});

// Solid-color PNG encoder at an arbitrary size (no canvas/sharp dependency needed).
function makeSolidPng(hex, width, height) {
  const zlib = require('zlib');
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2) || '11', 16);
  const g = parseInt(c.substring(2, 4) || '11', 16);
  const b = parseInt(c.substring(4, 6) || '11', 16);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData), 0);
    return Buffer.concat([len, typeData, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // One filter byte (0) + RGB triplet per pixel, repeated per row.
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
    }
  }
  const idatRaw = zlib.deflateSync(raw);

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatRaw),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Slides→PWA running at http://localhost:${PORT}`));
