// server.js — Slides→PWA backend
// Serves the frontend and proxies calls to the Anthropic API using a key
// the user supplies in the browser (never stored on disk unless the user
// explicitly saves it to a local .env — see README).

const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const archiver = require('archiver');
const path = require('path');

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
      (s, i) => `--- Section ${i + 1} ---
Title: ${s.title || '(untitled)'}
Content:
${s.content || '(no content provided — invent something reasonable that fits the title and overall narrative)'}`
    )
    .join('\n\n');

  const templateGuides = {
    blank: 'No visual direction has been set. Invent a coherent, distinctive design system (palette, type pairing, layout) that fits the subject matter of the content itself — do not fall back on generic AI-page defaults (cream+terracotta, near-black+neon accent, or a hairline-rule broadsheet grid) unless the content genuinely calls for it.',
    minimal: 'Minimal, editorial, lots of whitespace, restrained single accent color, precise spacing and type scale over decoration.',
    bold: 'High contrast, large confident type, one saturated signature color, strong section rhythm, a bit of motion on scroll/hover.',
    playful: 'Warm and approachable, rounded shapes okay, illustrative accents, friendly voice, light delightful micro-interactions.',
    dark: 'Dark-mode-first, moody, a single glowing accent color, technical/product feel, monospace touches for data or labels.',
  };

  return `You are building a single-page HTML landing page that will also work as an installable Progressive Web App. You will output ONE complete, self-contained HTML document — no markdown fences, no commentary, just the raw HTML starting with <!DOCTYPE html>.

DESIGN DIRECTION: ${templateGuides[template] || templateGuides.blank}
${brand ? `BRAND / EXTRA INSTRUCTIONS FROM THE USER: ${brand}` : ''}

CONTENT SOURCE: The page must be built from the following sections, in this order. Each section below should become one visually distinct part of the scrolling landing page (not literal slide rectangles — adapt them into a proper landing page flow: hero, sections, maybe a closing CTA). Preserve the actual meaning and facts; you may tighten or restyle the copy but do not invent facts that contradict the source.

${slidesBlock}

${sourceText ? `RAW SOURCE TEXT (for extra context/instructions, use alongside the sections above):\n${sourceText}\n` : ''}

TECHNICAL REQUIREMENTS:
- Single HTML file. All CSS in a <style> tag in <head>. Small vanilla JS in a <script> tag before </body> if needed (e.g. for scroll reveals, nav toggle). No external CSS/JS libraries or CDN fetches, other than an optional Google Fonts <link> if it fits the type direction.
- Add these PWA-related tags in <head>: <meta name="viewport" content="width=device-width, initial-scale=1">, <meta name="theme-color" content="[your accent hex]">, <link rel="manifest" href="manifest.json">.
- Fully responsive down to a 360px-wide phone. Visible keyboard focus states. Respect prefers-reduced-motion.
- Semantic HTML, real heading hierarchy, alt text on any decorative SVG/icons you draw inline.
- Do not include actual <img> tags pointing at external URLs (no placeholder image services) — if you want imagery, draw it with inline SVG/CSS instead.
- Follow the design-principles of a distinctive, opinionated design studio: pick a real palette (4–6 named hex values), a deliberate type pairing, a clear layout concept, and one signature visual element — then execute it with restraint elsewhere on the page.

Output only the raw HTML document.`;
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

    const anthropicRes = await fetch(ANTHROPIC_URL, {
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
    });

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

    res.json({ html });
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
