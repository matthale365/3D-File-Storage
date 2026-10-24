// Turns a model file (STEP, IGES, 3MF, STL) into a THREE.Group.
// Everything comes out in millimetres, Z-up (the CAD / slicer convention).
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { unzipSync, strFromU8 } from 'fflate';

export const DEFAULT_COLOR = '#8e9ca6';

const materialCache = new Map();
export function partMaterial(hex) {
  const key = hex.toLowerCase();
  if (!materialCache.has(key)) {
    materialCache.set(key, new THREE.MeshStandardMaterial({
      color: key,
      roughness: 0.62,
      metalness: 0.04,
      side: THREE.DoubleSide,
      polygonOffset: true, // lets edge lines sit cleanly on top of faces
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }));
  }
  return materialCache.get(key);
}

export function fileKind(name) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'step' || ext === 'stp') return 'step';
  if (ext === 'iges' || ext === 'igs') return 'iges';
  if (ext === '3mf') return '3mf';
  if (ext === 'stl') return 'stl';
  return null;
}

/** Download with progress. onProgress(loadedBytes, totalBytes|null) */
export async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download the file (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || null;
  if (!res.body || !res.body.getReader) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

export async function loadModel(url, kind, onStatus = () => {}) {
  const buffer = await fetchBytes(url, (loaded, total) => onStatus({ phase: 'download', loaded, total }));
  onStatus({ phase: 'convert' });
  if (kind === 'step' || kind === 'iges') return buildFromCad(await runCadKernel(buffer, kind));
  if (kind === '3mf') return parse3MF(buffer);
  if (kind === 'stl') return parseSTL(buffer);
  throw new Error('This file type has no preview.');
}

// ---------- STEP / IGES (OpenCascade in a Web Worker) ----------

let worker = null;
let queue = Promise.resolve();
function runCadKernel(buffer, format) {
  const job = () => new Promise((resolve, reject) => {
    worker ??= new Worker(new URL('./step-worker.js', import.meta.url));
    worker.onmessage = (ev) => (ev.data.ok ? resolve(ev.data.meshes) : reject(new Error(ev.data.error)));
    worker.onerror = (ev) => {
      worker = null;
      reject(new Error(ev.message || 'The CAD converter failed to start. Check your connection and reload.'));
    };
    worker.postMessage({ buffer, format }, [buffer]);
  });
  const p = queue.then(job, job);
  queue = p.catch(() => {});
  return p;
}

const rgbToHex = (c) => '#' + new THREE.Color(c[0], c[1], c[2]).getHexString();

function buildFromCad(meshes) {
  const group = new THREE.Group();
  for (const m of meshes) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
    if (m.normal) geom.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
    geom.setIndex(new THREE.BufferAttribute(m.index, 1));
    if (!m.normal) geom.computeVertexNormals();

    const base = m.color ? rgbToHex(m.color) : DEFAULT_COLOR;
    const faceColors = m.faces.some((f) => f.color);
    let material;
    if (faceColors) {
      // One draw group per run of faces sharing a colour.
      const mats = [];
      const slot = new Map();
      const slotFor = (hex) => {
        if (!slot.has(hex)) { slot.set(hex, mats.length); mats.push(partMaterial(hex)); }
        return slot.get(hex);
      };
      for (const f of m.faces) {
        const hex = f.color ? rgbToHex(f.color) : base;
        geom.addGroup(f.first * 3, (f.last - f.first + 1) * 3, slotFor(hex));
      }
      material = mats;
    } else {
      material = partMaterial(base);
    }
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = m.name || '';
    group.add(mesh);
  }
  if (!group.children.length) throw new Error('This file opened but contains no solid geometry.');
  return group;
}

// ---------- STL ----------

function parseSTL(buffer) {
  const geom = new STLLoader().parse(buffer);
  geom.computeVertexNormals();
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geom, partMaterial(DEFAULT_COLOR)));
  return group;
}

// ---------- 3MF (incl. Bambu Studio / Orca project files) ----------
// Bambu stores each object's mesh in its own file under 3D/Objects/ and
// references it from the main model with the 3MF "production" extension
// (p:path). three.js's built-in 3MF loader skips those, so we parse here.

const PROD_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const UNIT_SCALE = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

function children(el, name) {
  return Array.from(el.children).filter((c) => c.localName === name);
}
function first(el, name) {
  return children(el, name)[0] || null;
}
function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('This 3MF contains a damaged model file.');
  return doc;
}
function matrixFrom3mf(str) {
  const m = new THREE.Matrix4();
  if (!str) return m;
  const v = str.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some(Number.isNaN)) return m;
  // 3MF uses row vectors (p' = p * M); three.js uses column vectors.
  m.set(v[0], v[3], v[6], v[9],
        v[1], v[4], v[7], v[10],
        v[2], v[5], v[8], v[11],
        0, 0, 0, 1);
  return m;
}
function hexFromDisplayColor(s) {
  if (!s) return null;
  const m = /^#?([0-9a-f]{6})/i.exec(s.trim());
  return m ? '#' + m[1] : null;
}

export function parse3MF(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const byLower = new Map(Object.keys(files).map((k) => [k.toLowerCase(), k]));
  const read = (path) => {
    const key = byLower.get(String(path).replace(/^\/+/, '').toLowerCase());
    return key ? files[key] : null;
  };

  // Which file holds the main model?
  let rootPath = '3D/3dmodel.model';
  const rels = read('_rels/.rels');
  if (rels) {
    for (const r of parseXml(strFromU8(rels)).getElementsByTagName('Relationship')) {
      if (/\/3dmodel$/i.test(r.getAttribute('Type') || '')) { rootPath = r.getAttribute('Target'); break; }
    }
  }

  // Parse model files lazily; cache objects and colour resources by id.
  const models = new Map();
  function model(path) {
    const key = path.replace(/^\/+/, '').toLowerCase();
    if (models.has(key)) return models.get(key);
    const data = read(path);
    if (!data) throw new Error(`This 3MF is missing ${path}.`);
    const doc = parseXml(strFromU8(data));
    const root = doc.documentElement;
    const info = { path, root, objects: new Map(), colors: new Map(), unit: UNIT_SCALE[root.getAttribute('unit') || 'millimeter'] ?? 1 };
    const res = first(root, 'resources');
    if (res) {
      for (const el of res.children) {
        if (el.localName === 'object') info.objects.set(el.getAttribute('id'), el);
        else if (el.localName === 'basematerials') {
          info.colors.set(el.getAttribute('id'), children(el, 'base').map((b) => hexFromDisplayColor(b.getAttribute('displaycolor'))));
        } else if (el.localName === 'colorgroup') {
          info.colors.set(el.getAttribute('id'), children(el, 'color').map((c) => hexFromDisplayColor(c.getAttribute('color'))));
        }
      }
    }
    models.set(key, info);
    return info;
  }

  // Bambu / Orca: filament colours, plus which filament each object and each
  // part inside it uses (model_settings.config). Part ids match the objectid
  // of the component that points at that part's mesh.
  const filamentColors = [];
  const objectExtruder = new Map(); // object id -> filament number
  const partExtruder = new Map(); // "objectId/partId" -> filament number
  const plates = []; // [{ number, name, ids:Set<objectId> }]
  try {
    const ps = read('Metadata/project_settings.config');
    if (ps) for (const c of JSON.parse(strFromU8(ps)).filament_colour || []) filamentColors.push(hexFromDisplayColor(c));
  } catch { /* not a Bambu project, or unreadable — fall back to defaults */ }
  const extruderOf = (el) => {
    const m = children(el, 'metadata').find((x) => x.getAttribute('key') === 'extruder');
    const n = m ? Number(m.getAttribute('value')) : 0;
    return n > 0 ? n : 0; // 0 = "same as the object"
  };
  try {
    const ms = read('Metadata/model_settings.config');
    if (ms) {
      const msDoc = parseXml(strFromU8(ms));
      for (const obj of children(msDoc.documentElement, 'object')) {
        const oid = obj.getAttribute('id');
        const ex = extruderOf(obj);
        if (ex) objectExtruder.set(oid, ex);
        for (const part of children(obj, 'part')) {
          const pex = extruderOf(part);
          if (pex) partExtruder.set(oid + '/' + part.getAttribute('id'), pex);
        }
      }
      // Plates: which objects sit on which build plate.
      for (const plate of children(msDoc.documentElement, 'plate')) {
        const meta = (k) => children(plate, 'metadata').find((x) => x.getAttribute('key') === k)?.getAttribute('value');
        const ids = new Set();
        for (const inst of children(plate, 'model_instance')) {
          const id = children(inst, 'metadata').find((x) => x.getAttribute('key') === 'object_id')?.getAttribute('value');
          if (id) ids.add(id);
        }
        const n = Number(meta('plater_id')) || plates.length + 1;
        plates.push({ number: n, name: meta('plater_name') || '', ids });
      }
      plates.sort((a, b) => a.number - b.number);
    }
  } catch { /* ignore */ }
  const filament = (n) => (n > 0 && filamentColors[n - 1]) || null;

  // Builds a mesh, splitting it by colour. `baseColor` is the part's own
  // filament; triangles painted in the slicer (paint_color) override it.
  function buildMesh(info, objEl, baseColor) {
    const meshEl = first(objEl, 'mesh');
    const vertsEl = first(meshEl, 'vertices');
    const trisEl = first(meshEl, 'triangles');
    const vEls = vertsEl ? vertsEl.children : [];
    const tEls = trisEl ? trisEl.children : [];
    const pos = new Float32Array(vEls.length * 3);
    for (let i = 0; i < vEls.length; i++) {
      const v = vEls[i];
      pos[i * 3] = +v.getAttribute('x');
      pos[i * 3 + 1] = +v.getAttribute('y');
      pos[i * 3 + 2] = +v.getAttribute('z');
    }

    const buckets = new Map(); // hex -> number[] (flat xyz triangles)
    const bucket = (hex) => {
      if (!buckets.has(hex)) buckets.set(hex, []);
      return buckets.get(hex);
    };
    const colorForState = (state) => (state > 0 && filament(state)) || baseColor;
    const original = new Float32Array(tEls.length * 9); // unpainted copy, for edge lines
    const vert = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];

    for (let t = 0; t < tEls.length; t++) {
      const el = tEls[t];
      const a = vert(+el.getAttribute('v1'));
      const b = vert(+el.getAttribute('v2'));
      const c = vert(+el.getAttribute('v3'));
      original.set(a, t * 9); original.set(b, t * 9 + 3); original.set(c, t * 9 + 6);
      const paint = el.getAttribute('paint_color') || el.getAttribute('slic3rpe:mmu_segmentation');
      if (!paint) {
        bucket(baseColor).push(...a, ...b, ...c);
        continue;
      }
      decodePaint(paint, a, b, c, (p, q, r, state) => bucket(colorForState(state)).push(...p, ...q, ...r));
    }

    const geom = new THREE.BufferGeometry();
    const total = [...buckets.values()].reduce((n, arr) => n + arr.length, 0);
    const all = new Float32Array(total);
    const mats = [];
    let offset = 0;
    for (const [hex, arr] of buckets) {
      all.set(arr, offset);
      geom.addGroup(offset / 3, arr.length / 3, mats.length);
      mats.push(partMaterial(hex));
      offset += arr.length;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(all, 3));
    geom.computeVertexNormals(); // non-indexed, so this gives crisp flat faces

    const mesh = new THREE.Mesh(geom, mats.length === 1 ? mats[0] : mats);
    const edgeSource = new THREE.BufferGeometry();
    edgeSource.setAttribute('position', new THREE.BufferAttribute(original, 3));
    mesh.userData.edgeGeometry = edgeSource; // painted sub-triangles would add stray lines
    return mesh;
  }

  let group = new THREE.Group(); // where addObject puts meshes
  const scaleMatrix = (s) => new THREE.Matrix4().makeScale(s, s, s);

  // `topId` is the build item's object id, used to look up per-part filaments.
  function addObject(info, id, matrix, color, depth, topId) {
    if (depth > 16) return;
    const objEl = info.objects.get(id);
    if (!objEl) return;
    // Standard 3MF colour (material / colour group) on the object.
    const pid = objEl.getAttribute('pid');
    if (pid && info.colors.has(pid)) {
      const c = info.colors.get(pid)[Number(objEl.getAttribute('pindex') || 0)];
      if (c) color = c;
    }
    if (first(objEl, 'mesh')) {
      const mesh = buildMesh(info, objEl, color);
      mesh.applyMatrix4(new THREE.Matrix4().multiplyMatrices(matrix, scaleMatrix(info.unit)));
      mesh.name = objEl.getAttribute('name') || '';
      group.add(mesh);
    }
    const comps = first(objEl, 'components');
    if (comps) {
      for (const c of children(comps, 'component')) {
        const path = c.getAttributeNS(PROD_NS, 'path') || c.getAttribute('p:path');
        const target = path ? model(path) : info;
        const childId = c.getAttribute('objectid');
        const childColor = filament(partExtruder.get(topId + '/' + childId)) || color;
        const childMatrix = new THREE.Matrix4().multiplyMatrices(matrix, matrixFrom3mf(c.getAttribute('transform')));
        addObject(target, childId, childMatrix, childColor, depth + 1, topId);
      }
    }
  }

  const root = model(rootPath);
  const build = first(root.root, 'build');
  const items = build ? children(build, 'item') : [];
  const all = group;
  const plateGroups = new Map(); // plate number -> THREE.Group
  const plateOf = (id) => plates.find((p) => p.ids.has(id))?.number ?? plates[0]?.number ?? 1;
  for (const item of items) {
    if (item.getAttribute('printable') === '0') continue;
    const id = item.getAttribute('objectid');
    const pn = plateOf(id);
    if (!plateGroups.has(pn)) plateGroups.set(pn, new THREE.Group());
    group = plateGroups.get(pn);
    const color = filament(objectExtruder.get(id)) || DEFAULT_COLOR;
    const path = item.getAttributeNS(PROD_NS, 'path') || item.getAttribute('p:path');
    addObject(path ? model(path) : root, id, matrixFrom3mf(item.getAttribute('transform')), color, 0, id);
  }

  group = all;
  const used = [...plateGroups.entries()].filter(([, g]) => g.children.length).sort((a, b) => a[0] - b[0]);
  for (const [, g] of used) group.add(g);
  if (used.length > 1) {
    // Several plates: the page shows one at a time, like the slicer.
    group.userData.plates = used.map(([n, g]) => {
      const name = plates.find((p) => p.number === n)?.name;
      return { label: `Plate ${n}`, title: name || `Plate ${n}`, group: g };
    });
  }

  if (!group.children.length || !used.length) {
    throw new Error(read('Metadata/plate_1.gcode')
      ? 'This is a sliced print file (G-code only) — it has no model to preview. It can still be downloaded.'
      : 'This 3MF opened but contains no model geometry.');
  }
  return group;
}

// ---------- Slicer paint (multi-colour painting) ----------
// PrusaSlicer / Bambu Studio / Orca store painted colour per triangle as a hex
// string encoding a subdivision tree (TriangleSelector serialisation). Read
// from the end of the string, each hex digit is one 4-bit code:
//   low 2 bits = number of split sides (0 = leaf)
//   leaf:  high 2 bits = colour state; 3 means "read one more digit, add 3"
//   split: high 2 bits = which corner the split starts from
// Children are stored last-to-first. State 0 = the part's own filament,
// state n = filament n.
function decodePaint(str, a, b, c, emit) {
  let pos = str.length - 1;
  const next = () => (pos >= 0 ? parseInt(str[pos--], 16) || 0 : 0);
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
  const visit = (v0, v1, v2, depth) => {
    const code = next();
    const sides = code & 3;
    if (sides === 0 || depth > 12) {
      let state = code >> 2;
      if (state === 3) state = next() + 3;
      emit(v0, v1, v2, state);
      return;
    }
    const v = [v0, v1, v2];
    const s = code >> 2;
    const p = v[s % 3], q = v[(s + 1) % 3], r = v[(s + 2) % 3];
    let kids;
    if (sides === 1) {
      const m = mid(q, r);
      kids = [[p, q, m], [m, r, p]];
    } else if (sides === 2) {
      const m1 = mid(p, q), m2 = mid(p, r);
      kids = [[p, m1, m2], [m1, q, m2], [q, r, m2]];
    } else {
      const m1 = mid(p, q), m2 = mid(q, r), m3 = mid(p, r);
      kids = [[p, m1, m3], [m1, q, m2], [m2, r, m3], [m1, m2, m3]];
    }
    for (let k = kids.length - 1; k >= 0; k--) visit(kids[k][0], kids[k][1], kids[k][2], depth + 1);
  };
  visit(a, b, c, 0);
}
