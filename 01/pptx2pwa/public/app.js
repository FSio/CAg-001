(() => {
  const $ = sel => document.querySelector(sel);

  const apiKeyInput = $('#apiKey');
  const rememberKey = $('#rememberKey');
  const slidesList = $('#slidesList');
  const slideTemplate = $('#slideTemplate');
  const addSlideBtn = $('#addSlideBtn');
  const generateBtn = $('#generateBtn');
  const generateStatus = $('#generateStatus');
  const downloadBtn = $('#downloadBtn');
  const previewFrame = $('#previewFrame');
  const previewEmpty = $('#previewEmpty');
  const pptxInput = $('#pptxInput');
  const dropzoneLabel = $('#dropzoneLabel');
  const pptxStatus = $('#pptxStatus');
  const rawText = $('#rawText');

  let lastGeneratedHtml = null;

  // ---- API key persistence ----
  const savedKey = localStorage.getItem('slides2pwa_apiKey');
  if (savedKey) apiKeyInput.value = savedKey;
  apiKeyInput.addEventListener('input', () => {
    if (rememberKey.checked) localStorage.setItem('slides2pwa_apiKey', apiKeyInput.value);
  });
  rememberKey.addEventListener('change', () => {
    if (!rememberKey.checked) localStorage.removeItem('slides2pwa_apiKey');
    else localStorage.setItem('slides2pwa_apiKey', apiKeyInput.value);
  });

  // ---- Source tabs ----
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.source-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('#source-' + btn.dataset.source).classList.add('active');
    });
  });

  // ---- Slide cards ----
  function addSlide(title = '', content = '') {
    const node = slideTemplate.content.cloneNode(true);
    const card = node.querySelector('.slide-card');
    card.querySelector('.slide-title').value = title;
    card.querySelector('.slide-content').value = content;
    card.querySelector('.slide-remove').addEventListener('click', () => {
      card.remove();
      renumberSlides();
    });
    slidesList.appendChild(card);
    renumberSlides();
  }

  function renumberSlides() {
    const cards = slidesList.querySelectorAll('.slide-card');
    cards.forEach((card, i) => {
      card.querySelector('.slide-index').textContent = `Section ${i + 1}`;
      card.querySelector('.slide-remove').style.visibility = cards.length > 1 ? 'visible' : 'hidden';
    });
  }

  addSlideBtn.addEventListener('click', () => addSlide());

  // Start with exactly one slide configured, per spec.
  addSlide('Hero', '');

  // ---- PPTX upload ----
  const dropzone = document.querySelector('.dropzone');
  ['dragover', 'dragleave', 'drop'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.classList.toggle('dragover', evt === 'dragover');
    });
  });
  dropzone.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (file) handlePptxFile(file);
  });
  pptxInput.addEventListener('change', () => {
    if (pptxInput.files[0]) handlePptxFile(pptxInput.files[0]);
  });

  async function handlePptxFile(file) {
    dropzoneLabel.textContent = file.name;
    pptxStatus.textContent = 'Parsing slides…';
    pptxStatus.className = 'field-hint';
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/parse-pptx', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to parse file.');

      // Replace current sections with parsed slides.
      slidesList.innerHTML = '';
      data.slides.forEach(s => addSlide(s.title, s.content));
      pptxStatus.textContent = `Loaded ${data.slides.length} slide(s). Edit any section below before generating.`;
    } catch (err) {
      pptxStatus.textContent = err.message;
      pptxStatus.className = 'field-hint error';
    }
  }

  // ---- Generate ----
  generateBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      setStatus('Add your Anthropic API key first.', true);
      return;
    }

    const cards = [...slidesList.querySelectorAll('.slide-card')];
    const slides = cards.map(c => ({
      title: c.querySelector('.slide-title').value.trim(),
      content: c.querySelector('.slide-content').value.trim(),
    }));

    if (slides.length === 0) {
      setStatus('Add at least one section.', true);
      return;
    }

    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating…';
    setStatus('Calling Claude — this can take 20–60s for a full page…', false);

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          model: $('#modelSelect').value,
          template: $('#templateSelect').value,
          brand: $('#brandInput').value.trim(),
          slides,
          sourceText: rawText.value.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed.');

      lastGeneratedHtml = data.html;
      previewFrame.srcdoc = data.html;
      previewEmpty.style.display = 'none';
      downloadBtn.disabled = false;
      setStatus('Done. Review the preview, then download when happy.', false, true);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate landing page';
    }
  });

  function setStatus(msg, isError, isOk) {
    generateStatus.textContent = msg;
    generateStatus.className = 'field-hint' + (isError ? ' error' : isOk ? ' ok' : '');
  }

  // ---- Download ----
  downloadBtn.addEventListener('click', async () => {
    if (!lastGeneratedHtml) return;
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Packaging…';
    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html: lastGeneratedHtml, appName: $('#brandInput').value.trim() || 'My Landing Page' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Download failed.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'landing-page-pwa.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = 'Download PWA (.zip)';
    }
  });
})();
