import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const BASE_CANT = 41.5;
const G = 9.81;
const KNOT_TO_MS = 0.514444;

const $ = (id) => document.getElementById(id);

const ui = {
  scene: $('scene'),
  loading: $('loadingOverlay'),
  fatal: $('fatalError'),
  resetViewBtn: $('resetViewBtn'),
  playPauseBtn: $('playPauseBtn'),
  resetWaveBtn: $('resetWaveBtn'),
  resetMinBtn: $('resetMinBtn'),

  cantPort: $('cantPort'),
  cantPortValue: $('cantPortValue'),
  cantStbd: $('cantStbd'),
  cantStbdValue: $('cantStbdValue'),
  trim: $('trim'),
  trimValue: $('trimValue'),
  heel: $('heel'),
  heelValue: $('heelValue'),
  meanSink: $('meanSink'),
  meanSinkValue: $('meanSinkValue'),
  sinkPort: $('sinkPort'),
  sinkPortValue: $('sinkPortValue'),
  sinkStbd: $('sinkStbd'),
  sinkStbdValue: $('sinkStbdValue'),
  solvedHeel: $('solvedHeel'),

  attitudeInputs: $('attitudeInputs'),
  sinkInputs: $('sinkInputs'),

  waterModeLabel: $('waterModeLabel'),
  waveControls: $('waveControls'),
  waveHeight: $('waveHeight'),
  waveHeightValue: $('waveHeightValue'),
  waveLength: $('waveLength'),
  waveLengthValue: $('waveLengthValue'),
  waveDirection: $('waveDirection'),
  waveDirectionValue: $('waveDirectionValue'),
  autoWaveSpeed: $('autoWaveSpeed'),
  waveSpeedOut: $('waveSpeedOut'),
  manualWaveSpeedRow: $('manualWaveSpeedRow'),
  manualWaveSpeed: $('manualWaveSpeed'),
  manualWaveSpeedValue: $('manualWaveSpeedValue'),
  boatSpeed: $('boatSpeed'),
  boatSpeedValue: $('boatSpeedValue'),

  hullClearance: $('hullClearance'),
  clearanceStatus: $('clearanceStatus'),
  portSinkOut: $('portSinkOut'),
  stbdSinkOut: $('stbdSinkOut'),
  encounterPeriod: $('encounterPeriod'),
  currentClearance: $('currentClearance'),
  minClearance: $('minClearance'),
  meanSinkOut: $('meanSinkOut')
};

const state = {
  solveMode: 'attitude',
  waterMode: 'flat',
  cantPort: 41.5,
  cantStbd: 41.5,
  trim: 0,
  heel: 0,
  meanSink: 1.65,
  sinkPortTarget: 1.65,
  sinkStbdTarget: 1.65,
  waveHeight: 0.6,
  waveLength: 10,
  waveDirection: 0,
  autoWaveSpeed: true,
  manualWaveSpeed: 4,
  boatSpeedKn: 35,
  playbackSpeed: 1,
  playing: true,
  simTime: 0,
  minClearance: Infinity
};

let renderer, scene, camera, controls;
let boatRoot, modelScene, portCantGroup, stbdCantGroup;
let portFoilMarker, stbdFoilMarker;
let waveMesh, waterMaterial;
let hullSamplePoints = [];
let clearanceMarker, clearanceLine;
let modelReady = false;

const clock = new THREE.Clock();
const tempV = new THREE.Vector3();
const tempV2 = new THREE.Vector3();
const tempBox = new THREE.Box3();
const tempCenter = new THREE.Vector3();
const tempSize = new THREE.Vector3();

initScene();
bindUI();
loadModel();
animate();

function initScene() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x07111d, 0.018);

  camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
  camera.position.set(17, 8.2, 15);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(ui.scene.clientWidth, ui.scene.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  ui.scene.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.target.set(6.1, -0.15, 0);
  controls.minDistance = 6;
  controls.maxDistance = 45;
  controls.maxPolarAngle = Math.PI * 0.92;

  const hemi = new THREE.HemisphereLight(0xb8e7f2, 0x04101a, 2.0);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 3.1);
  key.position.set(6, 12, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -18;
  key.shadow.camera.right = 18;
  key.shadow.camera.top = 18;
  key.shadow.camera.bottom = -18;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x47e7db, 2.2);
  rim.position.set(-8, 2, -12);
  scene.add(rim);

  const floorGlow = new THREE.PointLight(0x47e7db, 12, 24, 2);
  floorGlow.position.set(7, -2, 0);
  scene.add(floorGlow);

  createWater();
  createClearanceVisuals();

  window.addEventListener('resize', onResize);
  onResize();
}

function createWater() {
  const sizeX = 60;
  const sizeZ = 46;
  const segX = 120;
  const segZ = 92;
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let iz = 0; iz <= segZ; iz++) {
    const vz = iz / segZ;
    const z = (vz - 0.5) * sizeZ;
    for (let ix = 0; ix <= segX; ix++) {
      const vx = ix / segX;
      const x = (vx - 0.5) * sizeX + 6;
      positions.push(x, 0, z);
      uvs.push(vx, vz);
    }
  }

  for (let iz = 0; iz < segZ; iz++) {
    for (let ix = 0; ix < segX; ix++) {
      const a = iz * (segX + 1) + ix;
      const b = a + 1;
      const c = a + (segX + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  waterMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x12384c,
    metalness: 0.02,
    roughness: 0.28,
    transmission: 0.08,
    transparent: true,
    opacity: 0.72,
    clearcoat: 0.55,
    clearcoatRoughness: 0.22,
    side: THREE.DoubleSide
  });

  waveMesh = new THREE.Mesh(geometry, waterMaterial);
  waveMesh.receiveShadow = true;
  scene.add(waveMesh);

  const grid = new THREE.GridHelper(60, 60, 0x245166, 0x173245);
  grid.position.y = 0.008;
  grid.material.opacity = 0.17;
  grid.material.transparent = true;
  grid.userData.isWaterGrid = true;
  scene.add(grid);
}

function createClearanceVisuals() {
  clearanceMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.065, 18, 18),
    new THREE.MeshBasicMaterial({ color: 0x47e7db })
  );
  clearanceMarker.visible = false;
  scene.add(clearanceMarker);

  const lineGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(),
    new THREE.Vector3()
  ]);
  clearanceLine = new THREE.Line(
    lineGeometry,
    new THREE.LineBasicMaterial({ color: 0x47e7db, transparent: true, opacity: 0.8 })
  );
  clearanceLine.visible = false;
  scene.add(clearanceLine);
}

function loadModel() {
  const loader = new GLTFLoader();

  loader.load(
    './ac40-model.gltf',
    (gltf) => {
      modelScene = gltf.scene;
      boatRoot = new THREE.Group();
      scene.add(boatRoot);
      boatRoot.add(modelScene);

      tuneMaterials(modelScene);
      setUpCantGroups();
      buildHullSamples();
      fitModelAndCamera();
      updateGeometryFromInputs(true);

      modelReady = true;
      ui.loading.classList.add('hidden');
      updateOutputs();
    },
    undefined,
    (error) => {
      console.error(error);
      ui.loading.classList.add('hidden');
      ui.fatal.hidden = false;
    }
  );
}

function tuneMaterials(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;

    obj.castShadow = true;
    obj.receiveShadow = true;

    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of materials) {
      if (!mat) continue;
      mat.side = THREE.DoubleSide;

      if ('metalness' in mat) mat.metalness = Math.min(mat.metalness ?? 0, 0.28);
      if ('roughness' in mat) mat.roughness = Math.max(mat.roughness ?? 0.45, 0.28);
      mat.needsUpdate = true;
    }
  });
}

function setUpCantGroups() {
  const candidates = [...modelScene.children].filter((obj) => {
    const n = (obj.name || '').toUpperCase();
    return n === 'ARM' || n === 'WINGIB';
  });

  const portMembers = [];
  const stbdMembers = [];

  for (const obj of candidates) {
    const box = new THREE.Box3().setFromObject(obj);
    box.getCenter(tempCenter);
    if (tempCenter.z < 0) portMembers.push(obj);
    else stbdMembers.push(obj);
  }

  const portPivot = new THREE.Vector3(6.61, 0.35, -1.385);
  const stbdPivot = new THREE.Vector3(6.61, 0.35, 1.385);

  portCantGroup = new THREE.Group();
  stbdCantGroup = new THREE.Group();
  portCantGroup.name = 'PortCantGroup';
  stbdCantGroup.name = 'StbdCantGroup';

  modelScene.add(portCantGroup, stbdCantGroup);
  reparentAroundPivot(portMembers, portCantGroup, portPivot);
  reparentAroundPivot(stbdMembers, stbdCantGroup, stbdPivot);

  // Foil-centre references at the T-wing / arm intersection.
  portFoilMarker = new THREE.Object3D();
  portFoilMarker.position.set(6.66, -2.265, -3.060).sub(portPivot);
  portCantGroup.add(portFoilMarker);

  stbdFoilMarker = new THREE.Object3D();
  stbdFoilMarker.position.set(6.66, -2.268, 3.030).sub(stbdPivot);
  stbdCantGroup.add(stbdFoilMarker);
}

function reparentAroundPivot(objects, group, pivot) {
  group.position.copy(pivot);

  for (const obj of objects) {
    modelScene.remove(obj);
    group.add(obj);
    obj.position.sub(pivot);
  }
}

function buildHullSamples() {
  hullSamplePoints = [];

  modelScene.updateMatrixWorld(true);

  modelScene.traverse((obj) => {
    if (!obj.isMesh) return;
    if (obj.parent === portCantGroup || obj.parent === stbdCantGroup) return;

    const name = (obj.name || '').toUpperCase();
    if (
      name.includes('RUDDER') ||
      name.includes('ELEVATOR') ||
      name.includes('LINE') ||
      name.includes('SCREENSHOT') ||
      name.includes('ARM') ||
      name.includes('WINGIB')
    ) return;

    const pos = obj.geometry?.attributes?.position;
    if (!pos) return;

    obj.geometry.computeBoundingBox();
    const box = obj.geometry.boundingBox.clone();
    box.getSize(tempSize);

    // The hull occupies roughly X 0–11.8 m and Y -0.43–1.02 m in the supplied model.
    // This filters out the foils, rudder and stray reference geometry.
    if (box.max.x > 12.5 || box.min.y < -0.65 || box.max.y > 1.25) return;

    // Sample every vertex. The supplied hull mesh is compact enough for real-time evaluation.
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i);
      p.applyMatrix4(obj.matrixWorld);
      hullSamplePoints.push(p);
    }
  });

  // Fallback so the display still works if object naming changes in a later model export.
  if (!hullSamplePoints.length) {
    modelScene.traverse((obj) => {
      if (!obj.isMesh) return;
      const pos = obj.geometry?.attributes?.position;
      if (!pos) return;
      obj.geometry.computeBoundingBox();
      const box = obj.geometry.boundingBox;
      if (box.min.y < -0.65 || box.max.x > 13) return;

      for (let i = 0; i < pos.count; i += 2) {
        const p = new THREE.Vector3().fromBufferAttribute(pos, i);
        p.applyMatrix4(obj.matrixWorld);
        hullSamplePoints.push(p);
      }
    });
  }
}

function fitModelAndCamera() {
  modelScene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(modelScene);
  box.getCenter(tempCenter);

  controls.target.set(6.2, -0.15, 0);
  setCameraView('perspective', false);
}

function bindUI() {
  bindRange(ui.cantPort, ui.cantPortValue, (v) => {
    state.cantPort = v;
    return `${v.toFixed(1)}°`;
  });

  bindRange(ui.cantStbd, ui.cantStbdValue, (v) => {
    state.cantStbd = v;
    return `${v.toFixed(1)}°`;
  });

  bindRange(ui.trim, ui.trimValue, (v) => {
    state.trim = v;
    return `${signed(v, 1)}°`;
  });

  bindRange(ui.heel, ui.heelValue, (v) => {
    state.heel = v;
    return `${signed(v, 1)}°`;
  });

  bindRange(ui.meanSink, ui.meanSinkValue, (v) => {
    state.meanSink = v;
    return `${v.toFixed(2)} m`;
  });

  bindRange(ui.sinkPort, ui.sinkPortValue, (v) => {
    state.sinkPortTarget = v;
    return `${v.toFixed(2)} m`;
  });

  bindRange(ui.sinkStbd, ui.sinkStbdValue, (v) => {
    state.sinkStbdTarget = v;
    return `${v.toFixed(2)} m`;
  });

  bindRange(ui.waveHeight, ui.waveHeightValue, (v) => {
    state.waveHeight = v;
    state.minClearance = Infinity;
    return `${v.toFixed(2)} m`;
  });

  bindRange(ui.waveLength, ui.waveLengthValue, (v) => {
    state.waveLength = v;
    state.minClearance = Infinity;
    updateWaveSpeedLabel();
    return `${v.toFixed(1)} m`;
  });

  bindRange(ui.waveDirection, ui.waveDirectionValue, (v) => {
    state.waveDirection = v;
    state.minClearance = Infinity;
    return `${signed(v, 0)}°`;
  });

  bindRange(ui.manualWaveSpeed, ui.manualWaveSpeedValue, (v) => {
    state.manualWaveSpeed = v;
    updateWaveSpeedLabel();
    return `${v.toFixed(1)} m/s`;
  });

  bindRange(ui.boatSpeed, ui.boatSpeedValue, (v) => {
    state.boatSpeedKn = v;
    return `${v.toFixed(1)} kn`;
  });

  document.querySelectorAll('#solveMode button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#solveMode button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      state.solveMode = button.dataset.mode;
      ui.attitudeInputs.hidden = state.solveMode !== 'attitude';
      ui.sinkInputs.hidden = state.solveMode !== 'sinks';

      if (modelReady && state.solveMode === 'sinks') {
        const live = getCurrentFoilSinks(false);
        state.sinkPortTarget = live.port;
        state.sinkStbdTarget = live.stbd;
        ui.sinkPort.value = live.port.toFixed(2);
        ui.sinkStbd.value = live.stbd.toFixed(2);
        ui.sinkPortValue.textContent = `${live.port.toFixed(2)} m`;
        ui.sinkStbdValue.textContent = `${live.stbd.toFixed(2)} m`;
      }

      state.minClearance = Infinity;
      updateGeometryFromInputs();
    });
  });

  document.querySelectorAll('#waterMode button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#waterMode button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      state.waterMode = button.dataset.water;
      ui.waveControls.classList.toggle('disabled', state.waterMode === 'flat');
      ui.waterModeLabel.textContent = state.waterMode === 'flat' ? 'Flat water' : 'Wave simulation';
      state.minClearance = Infinity;
      updateWaterGeometry();
    });
  });

  ui.autoWaveSpeed.addEventListener('change', () => {
    state.autoWaveSpeed = ui.autoWaveSpeed.checked;
    ui.manualWaveSpeedRow.hidden = state.autoWaveSpeed;
    updateWaveSpeedLabel();
    state.minClearance = Infinity;
  });

  document.querySelectorAll('.speed-group button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.speed-group button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      state.playbackSpeed = Number(button.dataset.speed);
    });
  });

  ui.playPauseBtn.addEventListener('click', () => {
    state.playing = !state.playing;
    ui.playPauseBtn.textContent = state.playing ? 'Ⅱ' : '▶';
    ui.playPauseBtn.setAttribute('aria-label', state.playing ? 'Pause playback' : 'Play');
  });

  ui.resetWaveBtn.addEventListener('click', () => {
    state.simTime = 0;
    state.minClearance = Infinity;
    updateWaterGeometry();
    updateOutputs();
  });

  ui.resetMinBtn.addEventListener('click', () => {
    state.minClearance = Infinity;
    updateOutputs();
  });

  ui.resetViewBtn.addEventListener('click', () => setCameraView('perspective'));

  document.querySelectorAll('.view-button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.view-button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      setCameraView(button.dataset.view);
    });
  });

  updateWaveSpeedLabel();
}

function bindRange(input, output, setter) {
  input.addEventListener('input', () => {
    const value = Number(input.value);
    output.textContent = setter(value);
    state.minClearance = Infinity;
    updateGeometryFromInputs();
    updateWaterGeometry();
    updateOutputs();
  });
}

function signed(value, decimals = 1) {
  const rounded = Number(value).toFixed(decimals);
  return value > 0 ? `+${rounded}` : rounded;
}

function updateGeometryFromInputs(initial = false) {
  if (!modelReady && !initial) return;
  if (!boatRoot || !portCantGroup || !stbdCantGroup) return;

  const portDelta = THREE.MathUtils.degToRad(state.cantPort - BASE_CANT);
  const stbdDelta = THREE.MathUtils.degToRad(state.cantStbd - BASE_CANT);

  portCantGroup.rotation.x = portDelta;
  stbdCantGroup.rotation.x = -stbdDelta;

  boatRoot.rotation.set(0, 0, 0, 'XYZ');
  boatRoot.position.set(0, 0, 0);

  if (state.solveMode === 'sinks') {
    solveHeelAndHeaveFromSinks();
  } else {
    boatRoot.rotation.x = THREE.MathUtils.degToRad(state.heel);
    boatRoot.rotation.z = THREE.MathUtils.degToRad(state.trim);
    boatRoot.updateMatrixWorld(true);

    // Adjust heave so the average foil-centre sink equals the requested mean sink
    // against the mean water plane (Y=0).
    const p = getMarkerWorldY(portFoilMarker);
    const s = getMarkerWorldY(stbdFoilMarker);
    const currentMeanSink = -(p + s) * 0.5;
    boatRoot.position.y += currentMeanSink - state.meanSink;
  }

  boatRoot.updateMatrixWorld(true);
}

function solveHeelAndHeaveFromSinks() {
  // Solve rigid-body heel and heave for requested port/stbd foil-centre depths.
  // Trim and cant remain as independent inputs.
  let heelDeg = state.heel;
  let heave = boatRoot.position.y;

  for (let iter = 0; iter < 8; iter++) {
    boatRoot.rotation.x = THREE.MathUtils.degToRad(heelDeg);
    boatRoot.rotation.z = THREE.MathUtils.degToRad(state.trim);
    boatRoot.position.y = heave;
    boatRoot.updateMatrixWorld(true);

    const yP = getMarkerWorldY(portFoilMarker);
    const yS = getMarkerWorldY(stbdFoilMarker);
    const fP = -yP - state.sinkPortTarget;
    const fS = -yS - state.sinkStbdTarget;

    if (Math.max(Math.abs(fP), Math.abs(fS)) < 1e-5) break;

    const epsH = 0.02;
    const epsY = 0.002;

    // Finite-difference Jacobian
    boatRoot.rotation.x = THREE.MathUtils.degToRad(heelDeg + epsH);
    boatRoot.position.y = heave;
    boatRoot.updateMatrixWorld(true);
    const hp = -getMarkerWorldY(portFoilMarker) - state.sinkPortTarget;
    const hs = -getMarkerWorldY(stbdFoilMarker) - state.sinkStbdTarget;

    boatRoot.rotation.x = THREE.MathUtils.degToRad(heelDeg);
    boatRoot.position.y = heave + epsY;
    boatRoot.updateMatrixWorld(true);
    const yp = -getMarkerWorldY(portFoilMarker) - state.sinkPortTarget;
    const ys = -getMarkerWorldY(stbdFoilMarker) - state.sinkStbdTarget;

    const a = (hp - fP) / epsH;
    const c = (hs - fS) / epsH;
    const b = (yp - fP) / epsY;
    const d = (ys - fS) / epsY;
    const det = a * d - b * c;

    if (Math.abs(det) < 1e-8) break;

    const dHeel = (-fP * d + b * fS) / det;
    const dHeave = (-a * fS + c * fP) / det;

    heelDeg += THREE.MathUtils.clamp(dHeel, -2.0, 2.0);
    heave += THREE.MathUtils.clamp(dHeave, -0.25, 0.25);
  }

  state.heel = heelDeg;
  boatRoot.rotation.x = THREE.MathUtils.degToRad(heelDeg);
  boatRoot.rotation.z = THREE.MathUtils.degToRad(state.trim);
  boatRoot.position.y = heave;
  boatRoot.updateMatrixWorld(true);
  ui.solvedHeel.textContent = `${signed(heelDeg, 2)}°`;
}

function getMarkerWorldY(marker) {
  marker.getWorldPosition(tempV);
  return tempV.y;
}

function waveSpeed() {
  if (!state.autoWaveSpeed) return state.manualWaveSpeed;
  return Math.sqrt((G * state.waveLength) / (2 * Math.PI));
}

function waveDirectionVector() {
  // UI convention: 0° = waves coming from the bow.
  // +X is forward on the supplied AC40 model, so head-sea propagation is -X.
  const theta = THREE.MathUtils.degToRad(state.waveDirection);
  return {
    x: -Math.cos(theta),
    z: Math.sin(theta)
  };
}

function encounterSpeedSigned() {
  const c = waveSpeed();
  const vBoat = state.boatSpeedKn * KNOT_TO_MS;
  const d = waveDirectionVector();
  const boatVelocityAlongWave = vBoat * d.x;
  return c - boatVelocityAlongWave;
}

function waterHeightAt(x, z, time = state.simTime) {
  if (state.waterMode === 'flat') return 0;

  const amplitude = state.waveHeight * 0.5;
  const k = (2 * Math.PI) / state.waveLength;
  const d = waveDirectionVector();
  const relativePhaseSpeed = encounterSpeedSigned();

  return amplitude * Math.sin(k * (d.x * (x - 6) + d.z * z - relativePhaseSpeed * time));
}

function updateWaterGeometry() {
  if (!waveMesh) return;

  const pos = waveMesh.geometry.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, waterHeightAt(x, z));
  }

  pos.needsUpdate = true;

  // Normals only need updating for waves. Throttle by frame count in animate.
  waterMaterial.opacity = state.waterMode === 'flat' ? 0.55 : 0.72;

  scene.traverse((obj) => {
    if (obj.userData?.isWaterGrid) obj.visible = state.waterMode === 'flat';
  });
}

function getCurrentFoilSinks(includeWaves = true) {
  if (!modelReady) return { port: NaN, stbd: NaN };

  portFoilMarker.getWorldPosition(tempV);
  const portWater = includeWaves ? waterHeightAt(tempV.x, tempV.z) : 0;
  const port = portWater - tempV.y;

  stbdFoilMarker.getWorldPosition(tempV2);
  const stbdWater = includeWaves ? waterHeightAt(tempV2.x, tempV2.z) : 0;
  const stbd = stbdWater - tempV2.y;

  return { port, stbd };
}

function getHullClearance() {
  if (!modelReady || !hullSamplePoints.length) {
    return { value: NaN, point: null, waterY: NaN };
  }

  boatRoot.updateMatrixWorld(true);

  let min = Infinity;
  let minPoint = null;
  let minWater = 0;

  for (const localModelPoint of hullSamplePoints) {
    tempV.copy(localModelPoint).applyMatrix4(boatRoot.matrixWorld);
    const waterY = waterHeightAt(tempV.x, tempV.z);
    const clearance = tempV.y - waterY;

    if (clearance < min) {
      min = clearance;
      minWater = waterY;
      if (!minPoint) minPoint = new THREE.Vector3();
      minPoint.copy(tempV);
    }
  }

  return { value: min, point: minPoint, waterY: minWater };
}

function updateOutputs() {
  if (!modelReady) return;

  const sinks = getCurrentFoilSinks(true);
  const clearance = getHullClearance();

  state.minClearance = Math.min(state.minClearance, clearance.value);

  ui.portSinkOut.textContent = formatMeters(sinks.port);
  ui.stbdSinkOut.textContent = formatMeters(sinks.stbd);
  ui.meanSinkOut.textContent = formatMeters((sinks.port + sinks.stbd) * 0.5);

  const className =
    clearance.value < 0 ? 'danger' :
    clearance.value < 0.12 ? 'warn' : 'safe';

  ui.hullClearance.className = className;
  ui.hullClearance.textContent = formatMM(clearance.value);
  ui.currentClearance.textContent = formatMM(clearance.value);
  ui.minClearance.textContent = Number.isFinite(state.minClearance) ? formatMM(state.minClearance) : '—';

  if (clearance.value < 0) {
    ui.clearanceStatus.textContent = 'Hull intersects water';
  } else if (clearance.value < 0.12) {
    ui.clearanceStatus.textContent = 'Low clearance';
  } else {
    ui.clearanceStatus.textContent = 'Clear';
  }

  const encounter = Math.abs(encounterSpeedSigned());
  if (state.waterMode === 'flat') {
    ui.encounterPeriod.textContent = '—';
  } else if (encounter < 0.05) {
    ui.encounterPeriod.textContent = '∞';
  } else {
    ui.encounterPeriod.textContent = `${(state.waveLength / encounter).toFixed(2)} s`;
  }

  updateWaveSpeedLabel();
  updateClearanceMarker(clearance);
}

function updateClearanceMarker(clearance) {
  if (!clearance.point) return;

  clearanceMarker.visible = true;
  clearanceLine.visible = true;

  clearanceMarker.position.copy(clearance.point);
  const color =
    clearance.value < 0 ? 0xff6677 :
    clearance.value < 0.12 ? 0xffcb6b :
    0x47e7db;

  clearanceMarker.material.color.setHex(color);
  clearanceLine.material.color.setHex(color);

  const arr = clearanceLine.geometry.attributes.position.array;
  arr[0] = clearance.point.x;
  arr[1] = clearance.point.y;
  arr[2] = clearance.point.z;
  arr[3] = clearance.point.x;
  arr[4] = clearance.waterY;
  arr[5] = clearance.point.z;
  clearanceLine.geometry.attributes.position.needsUpdate = true;
  clearanceLine.geometry.computeBoundingSphere();
}

function updateWaveSpeedLabel() {
  ui.waveSpeedOut.textContent = `${waveSpeed().toFixed(2)} m/s`;
}

function formatMeters(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(2)} m`;
}

function formatMM(value) {
  if (!Number.isFinite(value)) return '—';
  const mm = Math.round(value * 1000);
  return `${mm >= 0 ? '' : '−'}${Math.abs(mm)} mm`;
}

function setCameraView(view, animateTarget = true) {
  const target = new THREE.Vector3(6.0, -0.1, 0);
  let position;

  switch (view) {
    case 'side':
      position = new THREE.Vector3(6.0, 2.2, 22);
      break;
    case 'front':
      position = new THREE.Vector3(20, 1.4, 0);
      break;
    case 'top':
      position = new THREE.Vector3(6.0, 24, 0.01);
      break;
    default:
      position = new THREE.Vector3(17, 8.2, 15);
  }

  camera.position.copy(position);
  controls.target.copy(target);
  controls.update();
}

function onResize() {
  if (!renderer || !camera) return;
  const width = Math.max(1, ui.scene.clientWidth);
  const height = Math.max(1, ui.scene.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

let frameCounter = 0;
function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05);
  if (state.playing) {
    state.simTime += dt * state.playbackSpeed;
  }

  if (state.waterMode === 'waves' && state.playing) {
    updateWaterGeometry();
    frameCounter++;
    if (frameCounter % 8 === 0) {
      waveMesh.geometry.computeVertexNormals();
    }
  }

  if (modelReady) {
    updateOutputs();
  }

  controls.update();
  renderer.render(scene, camera);
}
