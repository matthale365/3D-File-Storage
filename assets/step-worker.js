// Runs the OpenCascade CAD kernel (occt-import-js, WebAssembly) off the main
// thread so the page stays responsive while a STEP/IGES file is converted
// into triangles the browser can draw.
const OCCT_URL = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/';

importScripts(OCCT_URL + 'occt-import-js.js');

let occtReady = null;

const PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.0008, // smaller = smoother curves, slower
  angularDeflection: 0.35,
};

onmessage = async (ev) => {
  const { buffer, format } = ev.data;
  try {
    occtReady ??= occtimportjs({ locateFile: (file) => OCCT_URL + file });
    const occt = await occtReady;
    const bytes = new Uint8Array(buffer);
    const result = format === 'iges'
      ? occt.ReadIgesFile(bytes, PARAMS)
      : occt.ReadStepFile(bytes, PARAMS);
    if (!result || !result.success) throw new Error('The CAD kernel could not read this file.');

    // Convert to typed arrays so they transfer to the page without copying.
    const meshes = result.meshes.map((m) => ({
      name: m.name,
      color: m.color || null,
      faces: (m.brep_faces || []).map((f) => ({ first: f.first, last: f.last, color: f.color || null })),
      position: new Float32Array(m.attributes.position.array),
      normal: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
      index: new Uint32Array(m.index.array),
    }));
    const transfer = [];
    for (const m of meshes) {
      transfer.push(m.position.buffer, m.index.buffer);
      if (m.normal) transfer.push(m.normal.buffer);
    }
    postMessage({ ok: true, meshes }, transfer);
  } catch (err) {
    postMessage({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
