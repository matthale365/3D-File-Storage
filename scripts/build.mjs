#!/usr/bin/env node
// Builds models.json (the list the website reads) from the models/ folder.
//
//   node scripts/build.mjs               list models, pull Bambu thumbnails
//   node scripts/build.mjs --thumbnails  also render a thumbnail for every
//                                        part that doesn't have one (needs
//                                        `npm install` for the headless browser)
//
// Folder rules:
//   models/<part-name>/            one part; every file inside is downloadable
//   models/<part-name>/info.json   optional: {"title", "description", "tags", "preview"}
//   models/<part-name>/thumbnail.png|jpg|webp   optional picture for the gallery
//   models/<file>.step             a loose file becomes its own part too
import { readdir, readFile, writeFile, stat, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'models');
const THUMBS = path.join(ROOT, 'thumbs');
const CACHE = path.join(ROOT, '.thumb-cache');
const RENDER_VERSION = 'r1'; // bump to re-render every thumbnail
const WANT_RENDER = process.argv.includes('--thumbnails');

const KINDS = { step: 'step', stp: 'step', iges: 'iges', igs: 'iges', '3mf': '3mf', stl: 'stl' };
const PREVIEW_ORDER = ['step', 'iges', '3mf', 'stl'];
const THUMB_NAMES = ['thumbnail.png', 'thumbnail.jpg', 'thumbnail.jpeg', 'thumbnail.webp'];
const SKIP = new Set(['info.json', ...THUMB_NAMES]);

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const kindOf = (name) => KINDS[name.toLowerCase().split('.').pop()] || 'other';
const slug = (s) => s.trim().replace(/\s+/g, '-');
function titleFrom(name) {
  const t = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function lastChanged(p) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', p], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (out) return out;
  } catch { /* not a git checkout */ }
  return null;
}

let fflate = null;
try { fflate = await import('fflate'); } catch { /* optional locally */ }

/** Look inside a 3MF: is it a Bambu/Orca project, and does it carry a plate picture? */
async function inspect3mf(file) {
  if (!fflate) return { bambu: false, thumb: null };
  try {
    const want = /^(metadata\/(plate_1\.png|thumbnail\.png|project_settings\.config)|3d\/3dmodel\.model)$/i;
    const files = fflate.unzipSync(new Uint8Array(await readFile(file)), { filter: (f) => want.test(f.name) });
    const get = (n) => Object.entries(files).find(([k]) => k.toLowerCase() === n)?.[1];
    const model = get('3d/3dmodel.model');
    const head = model ? fflate.strFromU8(model.subarray(0, 4000)) : '';
    const bambu = !!get('metadata/project_settings.config') || /BambuStudio|OrcaSlicer/i.test(head);
    return { bambu, thumb: get('metadata/plate_1.png') || get('metadata/thumbnail.png') || null };
  } catch (e) {
    console.warn(`  ! couldn't read ${rel(file)} as a 3MF: ${e.message}`);
    return { bambu: false, thumb: null };
  }
}

async function collect() {
  if (!existsSync(MODELS)) return [];
  const entries = (await readdir(MODELS, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
  const models = [];
  const used = new Set();
  const uniqueId = (base) => {
    let id = slug(base) || 'part';
    for (let n = 2; used.has(id); n++) id = `${slug(base)}-${n}`;
    used.add(id);
    return id;
  };

  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(MODELS, e.name);
    const names = (await readdir(dir, { withFileTypes: true }))
      .filter((f) => f.isFile() && !f.name.startsWith('.'))
      .map((f) => f.name);
    let info = {};
    if (names.includes('info.json')) {
      try { info = JSON.parse(await readFile(path.join(dir, 'info.json'), 'utf8')); }
      catch (err) { console.warn(`  ! ${rel(dir)}/info.json isn't valid JSON (${err.message}) — ignoring it`); }
    }
    const files = names.filter((n) => !SKIP.has(n.toLowerCase())).sort();
    if (!files.length) continue;
    const ownThumb = names.find((n) => THUMB_NAMES.includes(n.toLowerCase()));
    models.push({ id: uniqueId(e.name), dir, title: info.title || titleFrom(e.name), description: info.description || '', tags: Array.isArray(info.tags) ? info.tags : [], preview: info.preview || null, fileNames: files, ownThumb: ownThumb ? path.join(dir, ownThumb) : null });
  }
  for (const e of entries.filter((x) => x.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
    models.push({ id: uniqueId(e.name.replace(/\.[^.]+$/, '')), dir: MODELS, title: titleFrom(e.name), description: '', tags: [], preview: null, fileNames: [e.name], ownThumb: null, loose: true });
  }

  const out = [];
  for (const m of models) {
    const files = [];
    let bambuThumb = null;
    for (const name of m.fileNames) {
      const full = path.join(m.dir, name);
      const kind = kindOf(name);
      const f = { name, path: rel(full), kind, size: (await stat(full)).size };
      if (f.size > 95 * 1024 * 1024) console.warn(`  ! ${f.path} is ${(f.size / 1048576).toFixed(0)} MB — GitHub rejects files over 100 MB unless they use Git LFS.`);
      if (kind === '3mf') {
        const { bambu, thumb } = await inspect3mf(full);
        if (bambu) f.bambu = true;
        if (thumb && !bambuThumb) bambuThumb = thumb;
      }
      files.push(f);
    }

    let thumbnail = null;
    if (m.ownThumb) thumbnail = rel(m.ownThumb);
    else if (bambuThumb) {
      await mkdir(THUMBS, { recursive: true });
      await writeFile(path.join(THUMBS, `${m.id}.png`), bambuThumb);
      thumbnail = `thumbs/${m.id}.png`;
    }
    const previewable = files.filter((f) => PREVIEW_ORDER.includes(f.kind)).sort((a, b) => PREVIEW_ORDER.indexOf(a.kind) - PREVIEW_ORDER.indexOf(b.kind));
    const previewFile = previewable.find((f) => f.name === m.preview) || previewable[0] || null;

    out.push({
      id: m.id,
      title: m.title,
      description: m.description,
      tags: m.tags,
      preview: previewFile ? previewFile.name : null,
      thumbnail,
      updated: lastChanged(m.loose ? path.join(m.dir, m.fileNames[0]) : m.dir),
      files,
    });
  }
  // Newest first; parts without git history fall to the end alphabetically.
  out.sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || a.title.localeCompare(b.title));
  return out;
}

// ---------- thumbnail rendering with a headless browser ----------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() {
  const server = createServer(async (req, res) => {
    try {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, p === '/' ? 'index.html' : p);
      if (!file.startsWith(ROOT)) throw new Error('outside');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': body.length });
      res.end(body);
    } catch {
      res.writeHead(404); res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function renderThumbnails(models) {
  const todo = models.filter((m) => !m.thumbnail && m.preview);
  if (!todo.length) return;
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { console.warn('  ! Playwright not installed — skipping rendered thumbnails (run `npm install`).'); return; }

  await mkdir(THUMBS, { recursive: true });
  await mkdir(CACHE, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.warn('    page error:', e.message));
  if (process.env.CDN_MIRROR) {
    // Offline use: serve the CDN libraries from a local node_modules folder.
    await context.route(/^https:\/\/(cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com)\//, async (route) => {
      const m = /cdn\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.*)$/.exec(route.request().url());
      if (!m) return route.abort();
      const local = path.join(process.env.CDN_MIRROR, m[1], m[2]);
      if (!existsSync(local)) return route.abort();
      return route.fulfill({ body: await readFile(local), contentType: MIME[path.extname(local)] || (local.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'), headers: { 'access-control-allow-origin': '*' } });
    });
  }
  try {
    for (const m of todo) {
      const file = m.files.find((f) => f.name === m.preview);
      const hash = createHash('sha1').update(RENDER_VERSION).update(await readFile(path.join(ROOT, file.path))).digest('hex');
      const cached = path.join(CACHE, `${hash}.png`);
      const target = path.join(THUMBS, `${m.id}.png`);
      if (existsSync(cached)) {
        await copyFile(cached, target);
        m.thumbnail = `thumbs/${m.id}.png`;
        console.log(`  thumbnail (cached) ${m.id}`);
        continue;
      }
      const started = Date.now();
      await page.goto('about:blank');
      await page.goto(`${base}index.html#/thumb/${encodeURIComponent(m.id)}`);
      try {
        await page.waitForFunction(() => window.__thumb, null, { timeout: 180_000 });
      } catch {
        console.warn(`  ! timed out rendering ${m.id}`);
        continue;
      }
      if ((await page.evaluate(() => window.__thumb)) !== 'ready') {
        console.warn(`  ! couldn't render ${m.id} (the file may be damaged)`);
        continue;
      }
      await page.waitForTimeout(400);
      await page.locator('#stage').screenshot({ path: target });
      await copyFile(target, cached);
      m.thumbnail = `thumbs/${m.id}.png`;
      console.log(`  thumbnail ${m.id} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

// ---------- main ----------

await rm(THUMBS, { recursive: true, force: true });
const models = await collect();
const write = () => writeFile(path.join(ROOT, 'models.json'), JSON.stringify({ generated: new Date().toISOString(), models }, null, 2) + '\n');
await write(); // the thumbnail renderer reads this list
if (WANT_RENDER) {
  await renderThumbnails(models);
  await write();
}
console.log(`models.json: ${models.length} part${models.length === 1 ? '' : 's'}, ${models.reduce((n, m) => n + m.files.length, 0)} files`);
