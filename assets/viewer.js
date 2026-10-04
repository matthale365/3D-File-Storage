// The 3D stage: orbit/zoom/pan, standard views, edge lines, and a
// point-to-point measuring tool with vertex snapping.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const css = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function dotTexture(fill, ring) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(32, 32, 24, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = ring;
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.units = 'mm';
    this.measuring = false;
    this.measurements = [];
    this.onMeasurementsChange = () => {};
    this.onMeasureStateChange = () => {};

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    container.appendChild(this.renderer.domElement);

    this.labels = document.createElement('div');
    this.labels.className = 'stage-labels';
    container.appendChild(this.labels);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(css('--stage', '#dde2df'));
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(1, 2, 1.5);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000);
    this.camera.add(key); // headlight: the side you look at is always lit
    this.scene.add(this.camera);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;

    this.root = new THREE.Group(); // holds the part, rotated Z-up → Y-up
    this.root.rotation.x = -Math.PI / 2;
    this.scene.add(this.root);
    this.overlay = new THREE.Group(); // measurement lines & dots
    this.scene.add(this.overlay);

    this.ink = new THREE.Color(css('--ink', '#1d262b'));
    this.dotMat = new THREE.PointsMaterial({
      size: 13, sizeAttenuation: false, map: dotTexture(css('--caliper', '#f0b400'), css('--ink', '#1d262b')),
      transparent: true, alphaTest: 0.4, depthTest: false,
    });
    this.snapMat = new THREE.PointsMaterial({
      size: 17, sizeAttenuation: false, map: dotTexture('rgba(255,255,255,0.15)', css('--action', '#1f5a85')),
      transparent: true, alphaTest: 0.2, depthTest: false,
    });
    this.lineMat = new THREE.LineBasicMaterial({ color: this.ink, depthTest: false, transparent: true });

    this.hover = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)), this.dotMat);
    this.hover.renderOrder = 10;
    this.hover.visible = false;
    this.scene.add(this.hover);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pending = null; // first point of a measurement in progress
    this.rubber = null;

    this._bindEvents();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(container);
    this.renderer.setAnimationLoop(() => this._frame());
  }

  // ---------- model ----------

  setModel(part) {
    this.clear();
    this.part = part;
    this.meshes = [];
    part.traverse((o) => { if (o.isMesh) this.meshes.push(o); });

    // Size in the file's own axes (before turning it Y-up for display).
    const box = new THREE.Box3().setFromObject(part);
    this.size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    part.position.set(-center.x, -center.y, -box.min.z); // sit on the plate
    this.root.add(part);
    this.root.updateMatrixWorld(true);

    // Feature edges make CAD parts read like parts, not blobs.
    this.edges = new THREE.Group();
    let tris = 0;
    for (const m of this.meshes) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    if (tris < 1_500_000) {
      const edgeMat = new THREE.LineBasicMaterial({ color: this.ink, transparent: true, opacity: 0.55 });
      for (const m of this.meshes) {
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 28), edgeMat);
        e.matrixAutoUpdate = false;
        e.matrix.copy(m.matrixWorld);
        this.edges.add(e);
      }
    }
    this.edges.visible = this.showEdges ?? true;
    this.scene.add(this.edges);

    this._buildPlate();
    this.setView('iso');
  }

  clear() {
    this.clearMeasurements();
    this.cancelPending();
    if (this.part) this.root.remove(this.part);
    for (const k of ['edges', 'plate']) {
      if (this[k]) { this.scene.remove(this[k]); this[k].traverse((o) => o.geometry?.dispose()); this[k] = null; }
    }
    this.part = null;
    this.meshes = [];
  }

  _buildPlate() {
    const footprint = Math.max(this.size.x, this.size.y);
    const step = footprint > 1500 ? 100 : footprint > 300 ? 50 : 10;
    const extent = Math.max(step * 6, Math.ceil((footprint * 1.6) / step) * step);
    const grid = new THREE.GridHelper(extent, extent / step, css('--grid-major', '#a7b0aa'), css('--grid', '#c3cac5'));
    grid.material.transparent = true;
    grid.material.opacity = 0.9;
    grid.position.y = -0.01;
    this.plate = grid;
    this.scene.add(grid);
  }

  get radius() {
    return this.size ? this.size.length() / 2 : 50;
  }

  setView(name) {
    if (!this.part) return;
    const dirs = {
      iso: [1, 0.85, 1.15],
      front: [0, 0, 1],
      top: [0, 1, 0.001],
      right: [1, 0, 0],
    };
    const d = new THREE.Vector3(...(dirs[name] || dirs.iso)).normalize();
    const target = new THREE.Vector3(0, this.size.z * 0.42, 0); // a touch low so the part sits above the toolbar
    // Fit the eight corners of the part's box to the frame.
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, d).normalize();
    const camUp = new THREE.Vector3().crossVectors(d, right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const tanH = tanV * this.camera.aspect;
    const h = { x: this.size.x / 2, y: this.size.z / 2, z: this.size.y / 2 }; // displayed axes
    let dist = 0;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const c = new THREE.Vector3(sx * h.x, sy * h.y, sz * h.z);
      const along = c.dot(d);
      dist = Math.max(dist, along + Math.abs(c.dot(right)) / tanH, along + Math.abs(c.dot(camUp)) / tanV);
    }
    dist = Math.max(dist * 1.25, 1); // breathing room, and clear of the toolbar
    this.camera.position.copy(target).addScaledVector(d, dist);
    this.camera.near = Math.max(dist / 1000, 0.01);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();
  }

  setEdges(on) {
    this.showEdges = on;
    if (this.edges) this.edges.visible = on;
  }

  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  // ---------- measuring ----------

  setMeasure(on) {
    this.measuring = on;
    this.container.classList.toggle('is-measuring', on);
    if (!on) { this.cancelPending(); this.hover.visible = false; }
  }

  setUnits(u) {
    this.units = u;
    for (const m of this.measurements) m.label.textContent = this.format(m.a.distanceTo(m.b));
    this.onMeasurementsChange(this.measurements);
  }

  format(mm, withUnit = true) {
    const v = this.units === 'in' ? mm / 25.4 : mm;
    const digits = this.units === 'in' ? 3 : mm >= 1000 ? 1 : 2;
    return v.toFixed(digits) + (withUnit ? ' ' + this.units : '');
  }

  cancelPending() {
    if (this.pending) { this.overlay.remove(this.pending.dot); this.pending = null; }
    if (this.rubber) { this.overlay.remove(this.rubber.line); this.rubber.label.remove(); this.rubber = null; }
    this.onMeasureStateChange(false);
  }

  clearMeasurements() {
    for (const m of this.measurements) { this.overlay.remove(m.group); m.label.remove(); }
    this.measurements = [];
    this.onMeasurementsChange(this.measurements);
  }

  removeMeasurement(i) {
    const [m] = this.measurements.splice(i, 1);
    if (m) { this.overlay.remove(m.group); m.label.remove(); }
    this.onMeasurementsChange(this.measurements);
  }

  /** Difference between two points in the part's own X/Y/Z axes. */
  delta(a, b) {
    const la = this.root.worldToLocal(a.clone());
    const lb = this.root.worldToLocal(b.clone());
    return lb.sub(la);
  }

  _dot(p) {
    const pts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(p.toArray(), 3)), this.dotMat);
    pts.renderOrder = 11;
    return pts;
  }

  _label(cls) {
    const el = document.createElement('div');
    el.className = 'measure-tag ' + (cls || '');
    this.labels.appendChild(el);
    return el;
  }

  _pick(clientX, clientY) {
    if (!this.meshes?.length) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.meshes, false)[0];
    if (!hit) return null;

    // Snap to the nearest corner of the triangle under the cursor when close.
    const pos = hit.object.geometry.attributes.position;
    let best = null;
    let bestPx = 14;
    for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld);
      const s = v.clone().project(this.camera);
      const px = Math.hypot(((s.x + 1) / 2) * r.width + r.left - clientX, ((1 - s.y) / 2) * r.height + r.top - clientY);
      if (px < bestPx) { bestPx = px; best = v; }
    }
    return { point: best || hit.point.clone(), snapped: !!best };
  }

  _bindEvents() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointermove', (e) => {
      if (!this.measuring) return;
      this._lastMove = { x: e.clientX, y: e.clientY };
      this._moveDirty = true;
    });
    this.controls.addEventListener('change', () => { this._moveDirty = true; });
    el.addEventListener('pointerleave', () => { this._lastMove = null; this.hover.visible = false; });
    el.addEventListener('pointerup', (e) => {
      if (!this.measuring || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return; // that was an orbit drag, not a click
      const pick = this._pick(e.clientX, e.clientY);
      if (!pick) return;
      if (!this.pending) {
        const dot = this._dot(pick.point);
        this.overlay.add(dot);
        this.pending = { point: pick.point, dot };
        this.onMeasureStateChange(true);
      } else {
        this._addMeasurement(this.pending.point, pick.point);
        this.overlay.remove(this.pending.dot);
        this.pending = null;
        if (this.rubber) { this.overlay.remove(this.rubber.line); this.rubber.label.remove(); this.rubber = null; }
        this.onMeasureStateChange(false);
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.pending) this.cancelPending();
    });
  }

  _addMeasurement(a, b) {
    const group = new THREE.Group();
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), this.lineMat);
    line.renderOrder = 9;
    group.add(line, this._dot(a), this._dot(b));
    this.overlay.add(group);
    const label = this._label();
    label.textContent = this.format(a.distanceTo(b));
    this.measurements.push({ a, b, group, label });
    this.onMeasurementsChange(this.measurements);
  }

  _placeLabel(el, a, b) {
    const mid = a.clone().add(b).multiplyScalar(0.5).project(this.camera);
    if (mid.z > 1) { el.style.display = 'none'; return; }
    el.style.display = '';
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    el.style.transform = `translate(${((mid.x + 1) / 2) * w}px, ${((1 - mid.y) / 2) * h}px) translate(-50%, -50%)`;
  }

  // ---------- loop ----------

  _resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _frame() {
    this.controls.update();

    if (this.measuring && this._lastMove && this._moveDirty) {
      this._moveDirty = false;
      const pick = this._pick(this._lastMove.x, this._lastMove.y);
      this.hover.visible = !!pick;
      if (pick) {
        this.hover.material = pick.snapped ? this.snapMat : this.dotMat;
        this.hover.geometry.attributes.position.setXYZ(0, pick.point.x, pick.point.y, pick.point.z);
        this.hover.geometry.attributes.position.needsUpdate = true;
        if (this.pending) {
          if (!this.rubber) {
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.pending.point, pick.point]), this.lineMat);
            line.renderOrder = 9;
            this.overlay.add(line);
            this.rubber = { line, label: this._label('is-live') };
          }
          this.rubber.line.geometry.setFromPoints([this.pending.point, pick.point]);
          this.rubber.b = pick.point;
          this.rubber.label.textContent = this.format(this.pending.point.distanceTo(pick.point));
        }
      }
    }

    this.renderer.render(this.scene, this.camera);
    for (const m of this.measurements) this._placeLabel(m.label, m.a, m.b);
    if (this.rubber?.b) this._placeLabel(this.rubber.label, this.pending.point, this.rubber.b);
  }
}
