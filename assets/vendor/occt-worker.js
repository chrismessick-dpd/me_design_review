// Copied from Partcheck (partcheck/assets/occt-worker.js). PL passes its own pinned library (model3d.js).
// OpenCascade (occt-import-js) in a worker. Its WebAssembly glue builds functions from strings,
// which the page's Content-Security-Policy rightly forbids; a same-origin worker runs under its
// own (header-only) policy instead, and keeps the page responsive while a large STEP is read.
// The library and its .wasm are fetched with their pinned hashes (passed in by libs.js).
let occt = null;

async function load(lib) {
  const res = await fetch(lib.js, { integrity: lib.jsSri });
  if (!res.ok) throw new Error('Could not load the STEP reader (HTTP ' + res.status + ')');
  importScripts(URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' })));
  const w = await fetch(lib.wasm, { integrity: lib.wasmSri });
  if (!w.ok) throw new Error('Could not load the STEP reader (HTTP ' + w.status + ')');
  return self.occtimportjs({ wasmBinary: await w.arrayBuffer() });
}

self.onmessage = async e => {
  const { id, lib, kind, bytes, params } = e.data;
  try {
    if (!occt) { occt = load(lib); occt.catch(() => { occt = null; }); }
    const o = await occt;
    if (kind === 'init') { self.postMessage({ id, ok: true }); return; }
    const read = kind === 'iges' ? o.ReadIgesFile : kind === 'brep' ? o.ReadBrepFile : o.ReadStepFile;
    const t0 = performance.now();
    const r = read(bytes, params);
    const ms = Math.round(performance.now() - t0);
    const transfer = [];
    const meshes = (r.meshes || []).map(m => {
      const position = new Float32Array(m.attributes.position.array);
      const normal = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
      const index = new Uint32Array(m.index.array);
      transfer.push(position.buffer, index.buffer);
      if (normal) transfer.push(normal.buffer);
      return { name: m.name, color: m.color || null, brep_faces: m.brep_faces || [], attributes: { position: { array: position }, normal: normal ? { array: normal } : undefined }, index: { array: index } };
    });
    self.postMessage({ id, ok: true, result: { success: r.success, root: r.root, meshes, ms } }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
