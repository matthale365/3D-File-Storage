import { SITE } from '../site.config.js';
import { Viewer } from './viewer.js';
import { loadModel, fileKind, fetchBytes } from './loaders.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const url = (path) => path.split('/').map(encodeURIComponent).join('/');
const PREVIEW_ORDER = ['step', 'iges', '3mf', 'stl'];
const KIND_LABEL = { step: 'STEP', iges: 'IGES', '3mf': '3MF', stl: 'STL' };

function bytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}
function fileLabel(f) {
  const ext = f.name.split('.').pop().toUpperCase();
  if (f.kind === '3mf') return f.bambu ? 'Bambu Studio project (3MF)' : '3MF';
  return KIND_LABEL[f.kind] || ext;
}

// ---------- site chrome ----------
document.title = SITE.title;
$('brand').textContent = SITE.title;
$('site-title').textContent = SITE.title;
$('site-intro').textContent = SITE.intro;
if (SITE.footerLink?.url) {
  $('foot').innerHTML = `<a href="${esc(SITE.footerLink.url)}">${esc(SITE.footerLink.label || SITE.footerLink.url)}</a>`;
}

// ---------- data ----------
let library = null;
async function getLibrary() {
  if (library) return library;
  const res = await fetch('models.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('missing');
  library = await res.json();
  return library;
}

// ---------- gallery ----------
const PLACEHOLDER = `<svg viewBox="0 0 120 90" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M60 18 86 33v30L60 78 34 63V33z"/><path d="M34 33l26 15 26-15M60 48v30"/></g></svg>`;

function renderGallery(models, query = '') {
  const q = query.trim().toLowerCase();
  const shown = models.filter((m) => !q || [m.title, m.description, ...(m.tags || []), ...m.files.map((f) => f.name)].join(' ').toLowerCase().includes(q));
  $('count').textContent = q ? `${shown.length} of ${models.length} parts` : `${models.length} ${models.length === 1 ? 'part' : 'parts'}`;
  $('cards').innerHTML = shown.map((m) => {
    const kinds = [...new Set(m.files.map((f) => KIND_LABEL[f.kind] || f.name.split('.').pop().toUpperCase()))];
    const size = m.files.reduce((s, f) => s + f.size, 0);
    return `<li class="card">
      <a href="#/part/${encodeURIComponent(m.id)}">
        <div class="thumb">${m.thumbnail ? `<img src="${esc(url(m.thumbnail))}" alt="" loading="lazy">` : PLACEHOLDER}</div>
        <div class="card-body">
          <h2>${esc(m.title)}</h2>
          <p class="card-meta"><span class="formats">${kinds.map((k) => `<span class="fmt">${esc(k)}</span>`).join('')}</span><span>${bytes(size)}</span></p>
        </div>
      </a>
    </li>`;
  }).join('');
  const empty = $('gallery-empty');
  empty.hidden = shown.length > 0;
  if (!shown.length) {
    empty.innerHTML = models.length
      ? `<p>No parts match “${esc(query)}”. Try a shorter search.</p>`
      : `<p><strong>The library is empty.</strong> Add a folder inside <code>models/</code> with your STEP or 3MF files and push it to GitHub — the site rebuilds itself in about a minute.</p>`;
  }
}

$('search').addEventListener('input', (e) => library && renderGallery(library.models, e.target.value));

// ---------- detail ----------
let viewer = null;
let current = null; // { model, file }
let loadToken = 0;

function ensureViewer() {
  if (viewer) return viewer;
  viewer = new Viewer($('stage'));
  window.partsViewer = viewer; // handy for poking at in the browser console
  viewer.onMeasurementsChange = renderMeasurements;
  viewer.onMeasureStateChange = (pending) => showHint(pending ? 'Click a second point. Esc cancels.' : viewer.measuring ? 'Click a point on the part. Corners snap.' : '');
  return viewer;
}

function showHint(text) {
  $('measure-hint').hidden = !text;
  $('measure-hint').textContent = text;
}

function status({ text = '', progress = null, action = null } = {}) {
  const box = $('stage-status');
  box.hidden = !text;
  $('status-text').textContent = text;
  $('status-meter').hidden = progress === null;
  if (progress !== null) $('status-bar').style.width = Math.round(progress * 100) + '%';
  const btn = $('status-action');
  btn.hidden = !action;
  if (action) { btn.textContent = action.label; btn.onclick = action.run; }
}

function renderDims() {
  const v = viewer;
  $('envelope').hidden = !v?.part;
  if (!v?.part) return;
  $('dim-x').textContent = v.format(v.size.x, false);
  $('dim-y').textContent = v.format(v.size.y, false);
  $('dim-z').textContent = v.format(v.size.z, false);
  for (const b of document.querySelectorAll('[data-units]')) b.setAttribute('aria-pressed', String(b.dataset.units === v.units));
}

function renderMeasurements(list) {
  $('measure-block').hidden = !list.length;
  $('measure-list').innerHTML = list.map((m, i) => {
    const d = viewer.delta(m.a, m.b);
    return `<li><span class="m-total">${esc(viewer.format(m.a.distanceTo(m.b)))}</span>
      <span class="m-axes">ΔX ${esc(viewer.format(Math.abs(d.x), false))}  ΔY ${esc(viewer.format(Math.abs(d.y), false))}  ΔZ ${esc(viewer.format(Math.abs(d.z), false))}</span>
      <button type="button" class="link-btn" data-remove="${i}" aria-label="Remove measurement ${i + 1}">Remove</button></li>`;
  }).join('');
}
$('measure-list').addEventListener('click', (e) => {
  const i = e.target.closest('[data-remove]')?.dataset.remove;
  if (i !== undefined) viewer.removeMeasurement(Number(i));
});
$('measure-clear').addEventListener('click', () => viewer?.clearMeasurements());

async function preview(model, file, { force = false } = {}) {
  const v = ensureViewer();
  const token = ++loadToken;
  current = { model, file };
  v.clear();
  renderDims();
  for (const b of $('preview-buttons').children) b.setAttribute('aria-pressed', String(b.dataset.path === file.path));

  const limit = (SITE.autoPreviewLimitMB || 40) * 1024 * 1024;
  if (file.size > limit && !force) {
    status({ text: `This ${KIND_LABEL[file.kind]} file is ${bytes(file.size)}. Loading the preview downloads the whole file.`, action: { label: 'Load preview', run: () => preview(model, file, { force: true }) } });
    return;
  }
  status({ text: `Downloading ${file.name}`, progress: 0 });
  try {
    const part = await loadModel(url(file.path), file.kind, (s) => {
      if (token !== loadToken) return;
      if (s.phase === 'download') status({ text: `Downloading ${file.name}`, progress: (s.total || file.size) ? s.loaded / (s.total || file.size) : null });
      else status({ text: file.kind === 'step' || file.kind === 'iges' ? 'Converting CAD geometry' : 'Building preview' });
    });
    if (token !== loadToken) return;
    v.setModel(part);
    status();
    renderDims();
    window.__thumb = 'ready';
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    status({ text: `Couldn't show a preview: ${err.message} You can still download the file.` });
    window.__thumb = 'error';
  }
}

async function showPart(id, { thumbMode = false } = {}) {
  const lib = await getLibrary();
  const model = lib.models.find((m) => m.id === id);
  $('gallery').hidden = true;
  $('detail').hidden = false;
  if (!model) {
    $('part-title').textContent = 'Part not found';
    $('part-desc').textContent = 'This link points to a part that has been renamed or removed.';
    $('downloads').innerHTML = '';
    status({ text: 'Nothing to show.' });
    return;
  }
  document.title = `${model.title} · ${SITE.title}`;
  $('part-title').textContent = model.title;
  $('part-desc').textContent = model.description || '';
  $('part-desc').hidden = !model.description;
  $('part-tags').innerHTML = (model.tags || []).map((t) => `<li>${esc(t)}</li>`).join('');

  $('downloads').innerHTML = model.files.map((f) => `<li>
      <a class="dl" href="${esc(url(f.path))}" download="${esc(f.name)}">
        <span class="dl-name">${esc(f.name)}</span>
        <span class="dl-meta">${esc(fileLabel(f))}<span>${bytes(f.size)}</span></span>
      </a></li>`).join('');
  $('download-all').hidden = model.files.length < 2;

  const previewable = model.files
    .filter((f) => PREVIEW_ORDER.includes(f.kind))
    .sort((a, b) => PREVIEW_ORDER.indexOf(a.kind) - PREVIEW_ORDER.indexOf(b.kind));
  const preferred = previewable.find((f) => f.name === model.preview) || previewable[0];
  $('preview-pick').hidden = previewable.length < 2;
  $('preview-buttons').innerHTML = previewable.map((f) => `<button type="button" data-path="${esc(f.path)}">${esc(KIND_LABEL[f.kind])}</button>`).join('');

  ensureViewer();
  setMeasure(false);
  renderMeasurements([]);
  if (preferred) preview(model, preferred, { force: thumbMode });
  else { viewer.clear(); renderDims(); status({ text: 'This part has no file the browser can preview. Use the downloads.' }); window.__thumb = 'error'; }
  if (!thumbMode) $('part-title').focus?.();
}

$('preview-buttons').addEventListener('click', (e) => {
  const path = e.target.closest('button')?.dataset.path;
  if (!path || !current || path === current.file.path) return;
  preview(current.model, current.model.files.find((f) => f.path === path));
});

// toolbar
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewer?.setView(b.dataset.view)));
$('tool-edges').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  viewer?.setEdges(on);
});
function setMeasure(on) {
  $('tool-measure').setAttribute('aria-pressed', String(on));
  viewer?.setMeasure(on);
  showHint(on ? 'Click a point on the part. Corners snap.' : '');
}
$('tool-measure').addEventListener('click', () => setMeasure($('tool-measure').getAttribute('aria-pressed') !== 'true'));
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'm' && !$('detail').hidden && !e.target.closest('input, textarea')) setMeasure($('tool-measure').getAttribute('aria-pressed') !== 'true');
});
$('tool-image').addEventListener('click', () => {
  if (!viewer?.part) return;
  const a = document.createElement('a');
  a.href = viewer.snapshot();
  a.download = (current?.model.id || 'part') + '.png';
  a.click();
});
document.querySelectorAll('[data-units]').forEach((b) => b.addEventListener('click', () => {
  viewer?.setUnits(b.dataset.units);
  renderDims();
}));

$('download-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const model = current?.model;
  if (!model) return;
  btn.disabled = true;
  const original = btn.textContent;
  try {
    const { zipSync } = await import('fflate');
    const entries = {};
    for (const [i, f] of model.files.entries()) {
      btn.textContent = `Packing ${i + 1} of ${model.files.length}`;
      entries[f.name] = [new Uint8Array(await fetchBytes(url(f.path))), { level: 0 }];
    }
    const blob = new Blob([zipSync(entries)], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = model.id + '.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (err) {
    alert("Couldn't build the zip: " + err.message + ' Download the files one at a time instead.');
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
});

$('copy-link').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = 'Link copied';
  } catch {
    btn.textContent = 'Copy failed — use the address bar';
  }
  setTimeout(() => { btn.textContent = 'Copy link to this part'; }, 1800);
});

// ---------- routing ----------
async function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [page, ...rest] = hash.split('/');
  const id = rest.join('/');
  try {
    if (page === 'thumb') {
      document.body.classList.add('thumb-mode');
      await showPart(id, { thumbMode: true });
      return;
    }
    if (page === 'part' && id) {
      await showPart(id);
      return;
    }
    if (viewer) { viewer.clear(); setMeasure(false); loadToken++; status(); }
    document.title = SITE.title;
    $('detail').hidden = true;
    $('gallery').hidden = false;
    const lib = await getLibrary();
    renderGallery(lib.models, $('search').value);
  } catch {
    $('detail').hidden = true;
    $('gallery').hidden = false;
    $('cards').innerHTML = '';
    const box = $('gallery-empty');
    box.hidden = false;
    box.innerHTML = `<p><strong>The model list hasn't been built yet.</strong> GitHub builds <code>models.json</code> each time you push. If you're previewing on your own computer, run <code>node scripts/build.mjs</code> first, then reload.</p>`;
  }
}
window.addEventListener('hashchange', route);
route();
