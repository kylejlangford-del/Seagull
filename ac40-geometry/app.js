import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL_CANT_REFERENCE = 41.5;
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
  screenshotBtn: $('screenshotBtn'),

  cantPort: $('cantPort'),
  cantPortValue: $('cantPortValue'),
  cantStbd: $('cantStbd'),
  cantStbdValue: $('cantStbdValue'),
  trim: $('trim'),
  trimValue: $('trimValue'),
  heel: $('heel'),
  heelValue: $('heelValue'),
  sinkPortAttitude: $('sinkPortAttitude'),
  sinkPortAttitudeValue: $('sinkPortAttitudeValue'),
  sinkStbdAttitude: $('sinkStbdAttitude'),
  sinkStbdAttitudeValue: $('sinkStbdAttitudeValue'),
  portAttitudeSinkRow: $('portAttitudeSinkRow'),
  stbdAttitudeSinkRow: $('stbdAttitudeSinkRow'),
  attitudeSolvedLabel: $('attitudeSolvedLabel'),
  attitudeSolvedValue: $('attitudeSolvedValue'),
  sinkPort: $('sinkPort'),
  sinkPortValue: $('sinkPortValue'),
  sinkStbd: $('sinkStbd'),
  sinkStbdValue: $('sinkStbdValue'),
  solvedHeel: $('solvedHeel'),
  attitudeInputs: $('attitudeInputs'),
  sinkInputs: $('sinkInputs'),
  clearanceInputs: $('clearanceInputs'),
  heelClearance: $('heelClearance'),
  heelClearanceValue: $('heelClearanceValue'),
  clearanceTarget: $('clearanceTarget'),
  clearanceTargetValue: $('clearanceTargetValue'),
  portSinkRow: $('portSinkRow'),
  stbdSinkRow: $('stbdSinkRow'),
  verticalStatus: $('verticalStatus'),

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

  tableCantPort: $('tableCantPort'),
  tableCantStbd: $('tableCantStbd'),
  tableHeel: $('tableHeel'),
  tableTrim: $('tableTrim'),
  tableDrivers: $('tableDrivers'),
  tablePortSink: $('tablePortSink'),
  tableStbdSink: $('tableStbdSink'),
  tableWater: $('tableWater'),
  tableWaveHeight: $('tableWaveHeight'),
  tableWaveLength: $('tableWaveLength'),
  tableWaveSpeed: $('tableWaveSpeed'),
  tableWaveDirection: $('tableWaveDirection'),
  tableBoatSpeed: $('tableBoatSpeed'),
  tablePlayback: $('tablePlayback'),
  tableClearance: $('tableClearance'),
  tableMinClearance: $('tableMinClearance')
};

const state = {
  solveMode: 'attitude',
  waterMode: 'flat',
  cantPort: 50,
  cantStbd: 50,
  trim: 0,
  heel: 0,
  portSinkAttitude: -1.0,
  stbdSinkAttitude: -1.0,
  clearanceTarget: 0.30,
  sinkPortTarget: -1.0,
  sinkStbdTarget: -1.0,
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
const tempCenter = new THREE.Vector3();

initScene();
bindUI();
loadModel();
animate();

function initScene() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x07111d, 0.018);

  camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
  camera.position.set(17, 8.2, 15);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

  scene.add(new THREE.HemisphereLight(0xb8e7f2, 0x04101a, 2.0));

  const key = new THREE.DirectionalLight(0xffffff, 3.1);
  key.position.set(6, 12, 10);
  key.castShadow = true;
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
  const sizeX = 60, sizeZ = 46, segX = 120, segZ = 92;
  const positions = [], indices = [];

  for (let iz = 0; iz <= segZ; iz++) {
    const z = (iz / segZ - 0.5) * sizeZ;
    for (let ix = 0; ix <= segX; ix++) {
      const x = (ix / segX - 0.5) * sizeX + 6;
      positions.push(x, 0, z);
    }
  }

  for (let iz = 0; iz < segZ; iz++) {
    for (let ix = 0; ix < segX; ix++) {
      const a = iz * (segX + 1) + ix;
      const b = a + 1;
      const c = a + segX + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  waterMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x12384c,
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

  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(),
    new THREE.Vector3()
  ]);
  clearanceLine = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color: 0x47e7db, transparent: true, opacity: 0.8 })
  );
  clearanceLine.visible = false;
  scene.add(clearanceLine);
}

function loadModel() {
  new GLTFLoader().load(
    './ac40-model.gltf',
    (gltf) => {
      modelScene = gltf.scene;
      boatRoot = new THREE.Group();
      scene.add(boatRoot);
      boatRoot.add(modelScene);

      tuneMaterials(modelScene);
      setupCantAssemblies();
      buildHullSamples();
      setCameraView('perspective');

      modelReady = true;
      updateGeometryFromInputs();
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

function setupCantAssemblies() {
  modelScene.updateMatrixWorld(true);

  // v4.3: the GLTF itself now contains rigid port/starboard cant roots.
  // No runtime re-parenting or duplicate-name matching is needed.
  portCantGroup = modelScene.getObjectByName('PORT_FOIL_CANT_ROOT');
  stbdCantGroup = modelScene.getObjectByName('STBD_FOIL_CANT_ROOT');

  if (!portCantGroup || !stbdCantGroup) {
    throw new Error('Foil cant roots are missing from ac40-model.gltf');
  }

  portFoilMarker = new THREE.Object3D();
  portFoilMarker.name = 'PORT_T_FOIL_CENTRE';
  portFoilMarker.position.set(
    6.449 - 6.911853,
    -2.266 - 0.35055,
    -3.06043 - (-1.38623)
  );
  portCantGroup.add(portFoilMarker);

  stbdFoilMarker = new THREE.Object3D();
  stbdFoilMarker.name = 'STBD_T_FOIL_CENTRE';
  stbdFoilMarker.position.set(
    6.449 - 6.911853,
    -2.271 - 0.35055,
    3.06043 - 1.38292
  );
  stbdCantGroup.add(stbdFoilMarker);

  console.log('Rigid foil roots loaded:', {
    port: portCantGroup.children.map(o => o.name),
    starboard: stbdCantGroup.children.map(o => o.name)
  });
}


function buildHullSamples() {
  hullSamplePoints = [];
  modelScene.updateMatrixWorld(true);

  modelScene.traverse((obj) => {
    if (!obj.isMesh) return;
    if (isDescendantOf(obj, portCantGroup) || isDescendantOf(obj, stbdCantGroup)) return;

    const name = (obj.name || '').toUpperCase();
    if (name.includes('RUDDER') || name.includes('ELEVATOR') || name.includes('LINE') || name.includes('SCREENSHOT')) return;

    const pos = obj.geometry?.attributes?.position;
    if (!pos) return;

    obj.geometry.computeBoundingBox();
    const box = obj.geometry.boundingBox;
    if (box.max.x > 12.5 || box.min.y < -0.65 || box.max.y > 1.25) return;

    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i);
      p.applyMatrix4(obj.matrixWorld);
      hullSamplePoints.push(p);
    }
  });
}

function isDescendantOf(obj, parent) {
  let current = obj.parent;
  while (current) {
    if (current === parent) return true;
    current = current.parent;
  }
  return false;
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
    ui.heelClearance.value = v;
    ui.heelClearanceValue.textContent = `${signed(v, 1)}°`;
    return `${signed(v, 1)}°`;
  });

  bindRange(ui.sinkPortAttitude, ui.sinkPortAttitudeValue, (v) => {
    state.portSinkAttitude = v;
    return formatSignedMeters(v);
  });

  bindRange(ui.sinkStbdAttitude, ui.sinkStbdAttitudeValue, (v) => {
    state.stbdSinkAttitude = v;
    return formatSignedMeters(v);
  });

  bindRange(ui.heelClearance, ui.heelClearanceValue, (v) => {
    state.heel = v;
    ui.heel.value = v;
    ui.heelValue.textContent = `${signed(v, 1)}°`;
    return `${signed(v, 1)}°`;
  });

  bindRange(ui.clearanceTarget, ui.clearanceTargetValue, (v) => {
    state.clearanceTarget = v;
    return `${v.toFixed(2)} m`;
  });

  bindRange(ui.sinkPort, ui.sinkPortValue, (v) => {
    state.sinkPortTarget = v;
    return formatSignedMeters(v);
  });

  bindRange(ui.sinkStbd, ui.sinkStbdValue, (v) => {
    state.sinkStbdTarget = v;
    return formatSignedMeters(v);
  });

  bindRange(ui.waveHeight, ui.waveHeightValue, (v) => {
    state.waveHeight = v;
    return `${v.toFixed(2)} m`;
  });

  bindRange(ui.waveLength, ui.waveLengthValue, (v) => {
    state.waveLength = v;
    updateWaveSpeedLabel();
    return `${v.toFixed(1)} m`;
  });

  bindRange(ui.waveDirection, ui.waveDirectionValue, (v) => {
    state.waveDirection = v;
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
      setSolveMode(button.dataset.mode, false);
      state.minClearance = Infinity;
      updateGeometryFromInputs();
      updateOutputs();
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
      updateOutputs();
    });
  });

  ui.autoWaveSpeed.addEventListener('change', () => {
    state.autoWaveSpeed = ui.autoWaveSpeed.checked;
    ui.manualWaveSpeedRow.hidden = state.autoWaveSpeed;
    updateWaveSpeedLabel();
    state.minClearance = Infinity;
    updateOutputs();
  });

  document.querySelectorAll('.speed-group button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.speed-group button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      state.playbackSpeed = Number(button.dataset.speed);
      updateScenarioTable();
    });
  });

  ui.playPauseBtn.addEventListener('click', () => {
    state.playing = !state.playing;
    ui.playPauseBtn.textContent = state.playing ? 'Ⅱ' : '▶';
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
  ui.screenshotBtn.addEventListener('click', takeScenarioScreenshot);

  document.querySelectorAll('.view-button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.view-button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      setCameraView(button.dataset.view);
    });
  });

  updateWaveSpeedLabel();
  updateSinkAvailabilityUI();
  updateScenarioTable();
}

function bindRange(input, output, setter) {
  input.addEventListener('input', () => {
    const value = Number(input.value);
    output.textContent = setter(value);
    state.minClearance = Infinity;

    if (modelReady) updateGeometryFromInputs();
    updateWaterGeometry();
    updateOutputs();
  });
}

function updateGeometryFromInputs() {
  if (!modelReady) return;

  portCantGroup.rotation.x = THREE.MathUtils.degToRad(state.cantPort - MODEL_CANT_REFERENCE);
  stbdCantGroup.rotation.x = -THREE.MathUtils.degToRad(state.cantStbd - MODEL_CANT_REFERENCE);

  boatRoot.rotation.set(0, 0, 0, 'XYZ');
  boatRoot.position.set(0, 0, 0);
  boatRoot.updateMatrixWorld(true);

  enforceValidVerticalMode();

  if (state.solveMode === 'sinks') {
    solveHeelAndHeaveFromSinks();
  } else if (state.solveMode === 'clearance') {
    applyHeelAndClearance();
  } else {
    applyHeelAndActiveSink();
  }

  boatRoot.updateMatrixWorld(true);
  updateSinkAvailabilityUI();
}

function foilSinkActive(side) {
  return side === 'port' ? state.cantPort <= 90 : state.cantStbd <= 90;
}

function activeSinkSide() {
  if (foilSinkActive('port')) return 'port';
  if (foilSinkActive('stbd')) return 'stbd';
  return null;
}

function enforceValidVerticalMode() {
  const portActive = foilSinkActive('port');
  const stbdActive = foilSinkActive('stbd');

  if (state.solveMode === 'sinks' && !(portActive && stbdActive)) {
    setSolveMode((portActive || stbdActive) ? 'attitude' : 'clearance', true);
  }

  if (state.solveMode === 'attitude' && !(portActive || stbdActive)) {
    setSolveMode('clearance', true);
  }
}

function setSolveMode(mode, automatic = false) {
  const portActive = foilSinkActive('port');
  const stbdActive = foilSinkActive('stbd');

  if (mode === 'sinks' && !(portActive && stbdActive)) {
    mode = (portActive || stbdActive) ? 'attitude' : 'clearance';
  }
  if (mode === 'attitude' && !(portActive || stbdActive)) {
    mode = 'clearance';
  }

  state.solveMode = mode;

  document.querySelectorAll('#solveMode button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });

  ui.attitudeInputs.hidden = mode !== 'attitude';
  ui.sinkInputs.hidden = mode !== 'sinks';
  ui.clearanceInputs.hidden = mode !== 'clearance';

  updateSinkAvailabilityUI();

  if (automatic) {
    ui.verticalStatus.classList.add('warning');
  }
}

function updateSinkAvailabilityUI() {
  const portActive = foilSinkActive('port');
  const stbdActive = foilSinkActive('stbd');

  ui.portSinkRow.classList.toggle('is-disabled', !portActive);
  ui.stbdSinkRow.classList.toggle('is-disabled', !stbdActive);
  ui.portAttitudeSinkRow.classList.toggle('is-disabled', !portActive);
  ui.stbdAttitudeSinkRow.classList.toggle('is-disabled', !stbdActive);

  ui.sinkPort.disabled = !portActive;
  ui.sinkStbd.disabled = !stbdActive;
  ui.sinkPortAttitude.disabled = !portActive;
  ui.sinkStbdAttitude.disabled = !stbdActive;

  if (state.solveMode === 'attitude') {
    const side = activeSinkSide();

    ui.portAttitudeSinkRow.hidden = side !== 'port';
    ui.stbdAttitudeSinkRow.hidden = side !== 'stbd';

    ui.attitudeSolvedLabel.textContent = side === 'port' ? 'Starboard sink' : 'Port sink';
  }

  let status = 'Both foil sinks available';
  if (!portActive && !stbdActive) status = 'Both sinks OFF — heel + hull clearance drive vertical position';
  else if (!portActive) status = 'Port sink OFF (>90°) — heel + starboard sink or clearance';
  else if (!stbdActive) status = 'Starboard sink OFF (>90°) — heel + port sink or clearance';

  ui.verticalStatus.textContent = status;
  ui.verticalStatus.classList.toggle('warning', !portActive || !stbdActive);

  const sinksButton = document.querySelector('#solveMode button[data-mode="sinks"]');
  sinksButton.disabled = !(portActive && stbdActive);
  sinksButton.style.opacity = sinksButton.disabled ? '.35' : '1';
  sinksButton.style.cursor = sinksButton.disabled ? 'default' : 'pointer';
}

function applyHeelAndActiveSink() {
  const side = activeSinkSide();

  boatRoot.rotation.x = THREE.MathUtils.degToRad(state.heel);
  boatRoot.rotation.z = THREE.MathUtils.degToRad(state.trim);
  boatRoot.updateMatrixWorld(true);

  if (!side) {
    applyHeelAndClearance();
    return;
  }

  const marker = side === 'port' ? portFoilMarker : stbdFoilMarker;
  const target = side === 'port' ? state.portSinkAttitude : state.stbdSinkAttitude;

  marker.getWorldPosition(tempV);
  boatRoot.position.y += target - tempV.y;
}

function applyHeelAndClearance() {
  boatRoot.rotation.x = THREE.MathUtils.degToRad(state.heel);
  boatRoot.rotation.z = THREE.MathUtils.degToRad(state.trim);
  boatRoot.updateMatrixWorld(true);

  // Hull clearance changes 1:1 with pure vertical translation.
  const current = getHullClearance();
  if (Number.isFinite(current.value)) {
    boatRoot.position.y += state.clearanceTarget - current.value;
  }
}

function solveHeelAndHeaveFromSinks() {
  if (!(foilSinkActive('port') && foilSinkActive('stbd'))) {
    setSolveMode(activeSinkSide() ? 'attitude' : 'clearance', true);
    updateGeometryFromInputs();
    return;
  }
  let heelDeg = state.heel;
  let heave = 0;

  for (let iter = 0; iter < 10; iter++) {
    boatRoot.rotation.x = THREE.MathUtils.degToRad(heelDeg);
    boatRoot.rotation.z = THREE.MathUtils.degToRad(state.trim);
    boatRoot.position.y = heave;
    boatRoot.updateMatrixWorld(true);

    const yP = getMarkerWorldY(portFoilMarker);
    const yS = getMarkerWorldY(stbdFoilMarker);
    const fP = yP - state.sinkPortTarget;
    const fS = yS - state.sinkStbdTarget;

    if (Math.max(Math.abs(fP), Math.abs(fS)) < 1e-5) break;

    const epsH = 0.02;
    const epsY = 0.002;

    boatRoot.rotation.x = THREE.MathUtils.degToRad(heelDeg + epsH);
    boatRoot.position.y = heave;
    boatRoot.updateMatrixWorld(true);
    const hp = getMarkerWorldY(portFoilMarker) - state.sinkPortTarget;
    const hs = getMarkerWorldY(stbdFoilMarker) - state.sinkStbdTarget;

    boatRoot.rotation.x = THREE.MathUtils.degToRad(heelDeg);
    boatRoot.position.y = heave + epsY;
    boatRoot.updateMatrixWorld(true);
    const yp = getMarkerWorldY(portFoilMarker) - state.sinkPortTarget;
    const ys = getMarkerWorldY(stbdFoilMarker) - state.sinkStbdTarget;

    const a = (hp - fP) / epsH;
    const c = (hs - fS) / epsH;
    const b = (yp - fP) / epsY;
    const d = (ys - fS) / epsY;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-8) break;

    const dHeel = (-fP * d + b * fS) / det;
    const dHeave = (-a * fS + c * fP) / det;

    heelDeg += THREE.MathUtils.clamp(dHeel, -2, 2);
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
  return state.autoWaveSpeed
    ? Math.sqrt((G * state.waveLength) / (2 * Math.PI))
    : state.manualWaveSpeed;
}

function waveDirectionVector() {
  const theta = THREE.MathUtils.degToRad(state.waveDirection);
  return { x: -Math.cos(theta), z: Math.sin(theta) };
}

function encounterSpeedSigned() {
  const c = waveSpeed();
  const boat = state.boatSpeedKn * KNOT_TO_MS;
  const d = waveDirectionVector();
  return c - boat * d.x;
}

function waterHeightAt(x, z, time = state.simTime) {
  if (state.waterMode === 'flat') return 0;

  const amplitude = state.waveHeight * 0.5;
  const k = 2 * Math.PI / state.waveLength;
  const d = waveDirectionVector();

  return amplitude * Math.sin(
    k * (d.x * (x - 6) + d.z * z - encounterSpeedSigned() * time)
  );
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

  waterMaterial.opacity = state.waterMode === 'flat' ? 0.55 : 0.72;
  scene.traverse((obj) => {
    if (obj.userData?.isWaterGrid) obj.visible = state.waterMode === 'flat';
  });
}

function getCurrentFoilSinks(includeWaves = true) {
  if (!modelReady) return { port: NaN, stbd: NaN };

  portFoilMarker.getWorldPosition(tempV);
  const portWater = includeWaves ? waterHeightAt(tempV.x, tempV.z) : 0;
  const port = tempV.y - portWater;

  stbdFoilMarker.getWorldPosition(tempV2);
  const stbdWater = includeWaves ? waterHeightAt(tempV2.x, tempV2.z) : 0;
  const stbd = tempV2.y - stbdWater;

  return { port, stbd };
}

function getHullClearance() {
  if (!modelReady || hullSamplePoints.length === 0) {
    return { value: NaN, point: null, waterY: NaN };
  }

  boatRoot.updateMatrixWorld(true);

  let min = Infinity;
  let minPoint = null;
  let minWater = 0;

  for (const modelPoint of hullSamplePoints) {
    tempV.copy(modelPoint).applyMatrix4(boatRoot.matrixWorld);
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
  if (!modelReady) {
    updateScenarioTable();
    return;
  }

  const sinks = getCurrentFoilSinks(true);
  const clearance = getHullClearance();

  state.minClearance = Math.min(state.minClearance, clearance.value);

  const portActive = foilSinkActive('port');
  const stbdActive = foilSinkActive('stbd');

  ui.portSinkOut.textContent = portActive ? formatSignedMeters(sinks.port) : 'OFF';
  ui.stbdSinkOut.textContent = stbdActive ? formatSignedMeters(sinks.stbd) : 'OFF';

  if (state.solveMode === 'attitude') {
    const side = activeSinkSide();
    const solved = side === 'port' ? sinks.stbd : sinks.port;
    const solvedSideActive = side === 'port' ? stbdActive : portActive;
    ui.attitudeSolvedValue.textContent = solvedSideActive ? formatSignedMeters(solved) : 'OFF';
  }

  const className = clearance.value < 0 ? 'danger' : clearance.value < 0.12 ? 'warn' : 'safe';
  ui.hullClearance.className = className;
  ui.hullClearance.textContent = formatMM(clearance.value);
  ui.currentClearance.textContent = formatMM(clearance.value);
  ui.minClearance.textContent = Number.isFinite(state.minClearance) ? formatMM(state.minClearance) : '—';

  ui.clearanceStatus.textContent =
    clearance.value < 0 ? 'Hull intersects water' :
    clearance.value < 0.12 ? 'Low clearance' : 'Clear';

  const encounter = Math.abs(encounterSpeedSigned());
  ui.encounterPeriod.textContent =
    state.waterMode === 'flat' ? '—' :
    encounter < 0.05 ? '∞' :
    `${(state.waveLength / encounter).toFixed(2)} s`;

  updateWaveSpeedLabel();
  updateClearanceMarker(clearance);
  updateScenarioTable(sinks, clearance);
}

function updateScenarioTable(sinks = null, clearance = null) {
  ui.tableCantPort.textContent = `${state.cantPort.toFixed(1)}°`;
  ui.tableCantStbd.textContent = `${state.cantStbd.toFixed(1)}°`;
  ui.tableHeel.textContent = `${signed(state.heel, 1)}°`;
  ui.tableTrim.textContent = `${signed(state.trim, 1)}°`;
  ui.tableDrivers.textContent = currentDriverLabel();

  if (sinks) {
    ui.tablePortSink.textContent = foilSinkActive('port') ? formatSignedMeters(sinks.port) : 'OFF (>90°)';
    ui.tableStbdSink.textContent = foilSinkActive('stbd') ? formatSignedMeters(sinks.stbd) : 'OFF (>90°)';
  }

  ui.tableDrivers.textContent = currentDriverLabel();

  ui.tableWater.textContent = state.waterMode === 'flat' ? 'Flat' : 'Waves';
  ui.tableWaveHeight.textContent = state.waterMode === 'waves' ? `${state.waveHeight.toFixed(2)} m` : '—';
  ui.tableWaveLength.textContent = state.waterMode === 'waves' ? `${state.waveLength.toFixed(1)} m` : '—';
  ui.tableWaveSpeed.textContent = state.waterMode === 'waves' ? `${waveSpeed().toFixed(2)} m/s` : '—';
  ui.tableWaveDirection.textContent = state.waterMode === 'waves' ? `${signed(state.waveDirection, 0)}°` : '—';
  ui.tableBoatSpeed.textContent = `${state.boatSpeedKn.toFixed(1)} kn`;
  ui.tablePlayback.textContent = `${state.playbackSpeed}×`;

  if (clearance) {
    ui.tableClearance.textContent = formatMM(clearance.value);
    ui.tableMinClearance.textContent = Number.isFinite(state.minClearance)
      ? formatMM(state.minClearance)
      : '—';
  }
}

function currentDriverLabel() {
  if (state.solveMode === 'clearance') return 'Heel + hull clearance';
  if (state.solveMode === 'sinks') return 'Port + starboard sink';
  const side = activeSinkSide();
  return side === 'port'
    ? 'Heel + port sink'
    : side === 'stbd'
      ? 'Heel + starboard sink'
      : 'Heel + hull clearance';
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

function signed(value, decimals = 1) {
  const n = Number(value).toFixed(decimals);
  return value > 0 ? `+${n}` : n;
}

function formatSignedMeters(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)} m`;
}

function clampSink(value) {
  return THREE.MathUtils.clamp(value, -1.5, -0.50);
}

function formatMM(value) {
  if (!Number.isFinite(value)) return '—';
  const mm = Math.round(value * 1000);
  return `${mm < 0 ? '−' : ''}${Math.abs(mm)} mm`;
}

function setCameraView(view) {
  const target = new THREE.Vector3(6.0, -0.1, 0);
  let position;

  if (view === 'side') position = new THREE.Vector3(6.0, 2.2, 22);
  else if (view === 'front') position = new THREE.Vector3(20, 1.4, 0);
  else if (view === 'top') position = new THREE.Vector3(6.0, 24, 0.01);
  else position = new THREE.Vector3(17, 8.2, 15);

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

function getScenarioRows() {
  return [
    ['Cant port', ui.tableCantPort.textContent],
    ['Cant starboard', ui.tableCantStbd.textContent],
    ['Heel', ui.tableHeel.textContent],
    ['Trim', ui.tableTrim.textContent],
    ['Drivers', ui.tableDrivers.textContent],
    ['Port sink', ui.tablePortSink.textContent],
    ['Starboard sink', ui.tableStbdSink.textContent],
    ['Water', ui.tableWater.textContent],
    ['Wave height', ui.tableWaveHeight.textContent],
    ['Wavelength', ui.tableWaveLength.textContent],
    ['Wave speed', ui.tableWaveSpeed.textContent],
    ['Wave direction', ui.tableWaveDirection.textContent],
    ['Boat speed', ui.tableBoatSpeed.textContent],
    ['Playback', ui.tablePlayback.textContent],
    ['Hull clearance', ui.tableClearance.textContent],
    ['Minimum clearance', ui.tableMinClearance.textContent]
  ];
}

function takeScenarioScreenshot() {
  if (!modelReady) return;

  renderer.render(scene, camera);

  const source = renderer.domElement;
  const viewWidth = 1500;
  const viewHeight = Math.round(viewWidth * source.height / source.width);
  const panelWidth = 360;

  const canvas = document.createElement('canvas');
  canvas.width = panelWidth + viewWidth;
  canvas.height = viewHeight;

  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#06101b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, panelWidth, 0, viewWidth, viewHeight);

  ctx.fillStyle = '#0a1725';
  ctx.fillRect(0, 0, panelWidth, viewHeight);

  ctx.fillStyle = '#47e7db';
  ctx.font = '700 17px Arial';
  ctx.fillText('SEAGULL LAB', 28, 40);

  ctx.fillStyle = '#edf5fb';
  ctx.font = '700 27px Arial';
  ctx.fillText('AC40 Geometry', 28, 78);

  ctx.fillStyle = '#8fa2b5';
  ctx.font = '700 12px Arial';
  ctx.fillText('SCENARIO', 28, 112);

  const rows = getScenarioRows();
  let y = 145;

  for (const [label, value] of rows) {
    ctx.fillStyle = '#8fa2b5';
    ctx.font = '500 12px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(label, 28, y);

    ctx.fillStyle = '#edf5fb';
    ctx.font = '600 12px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(value, panelWidth - 28, y);

    ctx.strokeStyle = 'rgba(132,151,174,.15)';
    ctx.beginPath();
    ctx.moveTo(28, y + 12);
    ctx.lineTo(panelWidth - 28, y + 12);
    ctx.stroke();

    y += 32;
  }

  ctx.textAlign = 'left';
  ctx.fillStyle = '#6f8598';
  ctx.font = '500 11px Arial';
  ctx.fillText(new Date().toLocaleString(), 28, viewHeight - 28);

  const link = document.createElement('a');
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');

  link.download = `ac40-scenario-${stamp}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

let frameCounter = 0;

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05);
  if (state.playing) state.simTime += dt * state.playbackSpeed;

  if (state.waterMode === 'waves' && state.playing) {
    updateWaterGeometry();
    frameCounter++;
    if (frameCounter % 8 === 0) waveMesh.geometry.computeVertexNormals();
  }

  if (modelReady) updateOutputs();

  controls.update();
  renderer.render(scene, camera);
}
