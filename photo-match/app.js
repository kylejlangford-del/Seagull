import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Same rig as AC40 Geometry: the GLTF's own baked pose already encodes a
// real 41.5-degree cant reference, so cant sliders are offsets from that,
// not absolute rotations from zero.
const MODEL_CANT_REFERENCE = 41.5;
const $ = (id) => document.getElementById(id);

const ui = {
  scene: $('scene'),
  viewportBox: $('viewportBox'),
  photoLayer: $('photoLayer'),
  photoInput: $('photoInput'),
  photoFileName: $('photoFileName'),
  loading: $('loadingOverlay'),
  fatal: $('fatalError'),
  resetBtn: $('resetBtn'),

  modelOpacity: $('modelOpacity'),
  modelOpacityValue: $('modelOpacityValue'),
  wireframeToggle: $('wireframeToggle'),
  waterlineToggle: $('waterlineToggle'),

  cantPort: $('cantPort'),
  cantPortValue: $('cantPortValue'),
  cantStbd: $('cantStbd'),
  cantStbdValue: $('cantStbdValue'),
  heel: $('heel'),
  heelValue: $('heelValue'),
  trim: $('trim'),
  trimValue: $('trimValue'),
  ridePosition: $('ridePosition'),
  ridePositionValue: $('ridePositionValue'),

  outCantPort: $('outCantPort'),
  outCantStbd: $('outCantStbd'),
  outSinkPort: $('outSinkPort'),
  outSinkStbd: $('outSinkStbd'),

  camAlong: $('camAlong'),
  camAlongValue: $('camAlongValue'),
  camHeight: $('camHeight'),
  camHeightValue: $('camHeightValue'),
  camAthwart: $('camAthwart'),
  camAthwartValue: $('camAthwartValue'),
  camPan: $('camPan'),
  camPanValue: $('camPanValue'),
  camTilt: $('camTilt'),
  camTiltValue: $('camTiltValue'),
  camFov: $('camFov'),
  camFovValue: $('camFovValue'),
  onboardControls: $('onboardControls'),
  onboardPresets: $('onboardPresets'),
  externalPresets: $('externalPresets'),
  cameraHint: $('cameraHint')
};

const defaults = {
  cantPort: 55,
  cantStbd: 55,
  heel: 0,
  trim: 0,
  ridePosition: 0,
  camAlong: 0,
  camHeight: 0,
  camAthwart: 0,
  camPan: -35,
  camTilt: -15,
  camFov: 100
};

const state = {
  cantPort: defaults.cantPort,
  cantStbd: defaults.cantStbd,
  heel: defaults.heel,
  trim: defaults.trim,
  ridePosition: defaults.ridePosition,
  cameraMode: 'onboard',
  camAlong: defaults.camAlong,
  camHeight: defaults.camHeight,
  camAthwart: defaults.camAthwart,
  camPan: defaults.camPan,
  camTilt: defaults.camTilt,
  camFov: defaults.camFov
};

// Onboard rig base position, in boat-local coordinates (X = fore/aft,
// bow at larger X; Y = up; Z = athwartships, starboard positive). Estimated
// from the hull's own bounding box (bow tip near X=11.8) to sit just aft of
// the bow, elevated a little above deck level, matching a bolted-on bow cam.
const ONBOARD_BASE = new THREE.Vector3(10.6, 1.0, 0);

const ONBOARD_PRESETS = {
  'bow-leeward': { along: 0, height: 0, athwart: 0, pan: -35, tilt: -15 },
  'bow-windward': { along: 0, height: 0, athwart: 0, pan: 35, tilt: -15 },
  'stern': { along: -9.2, height: 0.4, athwart: 0, pan: 0, tilt: -6 }
};

const EXTERNAL_TARGET = new THREE.Vector3(6.0, -0.1, 0);
const EXTERNAL_PRESETS = {
  'beam': new THREE.Vector3(6.0, 1.6, 20),
  'bow-on': new THREE.Vector3(21, 1.6, 0),
  'stern-on': new THREE.Vector3(-13, 1.6, 0),
  'three-quarter': new THREE.Vector3(17, 5.5, 11),
  'elevated': new THREE.Vector3(9, 15, 13)
};

let renderer, scene, camera, controls;
let boatRoot, modelScene, portCantGroup, stbdCantGroup;
let portFoilMarker, stbdFoilMarker;
let waterPlane, waterGrid;
let modelReady = false;
let modelMeshes = [];

const tempV = new THREE.Vector3();

initScene();
bindUI();
loadModel();
animate();

function initScene() {
  scene = new THREE.Scene();
  scene.background = null;

  camera = new THREE.PerspectiveCamera(defaults.camFov, 1, 0.02, 200);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  ui.scene.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.copy(EXTERNAL_TARGET);
  controls.minDistance = 3;
  controls.maxDistance = 60;
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.enabled = false;

  scene.add(new THREE.HemisphereLight(0xb8e7f2, 0x04101a, 2.2));

  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.position.set(6, 12, 10);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x47e7db, 1.8);
  rim.position.set(-8, 2, -12);
  scene.add(rim);

  createWaterGuide();

  window.addEventListener('resize', onResize);
  onResize();
}

function createWaterGuide() {
  const geometry = new THREE.PlaneGeometry(60, 46, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    color: 0x12384c,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  waterPlane = new THREE.Mesh(geometry, material);
  waterPlane.position.set(6, 0, 0);
  scene.add(waterPlane);

  waterGrid = new THREE.GridHelper(60, 40, 0x69fff2, 0x2c5468);
  waterGrid.position.set(6, 0.004, 0);
  waterGrid.material.transparent = true;
  waterGrid.material.opacity = 0.22;
  scene.add(waterGrid);
}

function loadModel() {
  new GLTFLoader().load(
    '../ac40-geometry/ac40-model.gltf',
    (gltf) => {
      modelScene = gltf.scene;
      boatRoot = new THREE.Group();
      scene.add(boatRoot);
      boatRoot.add(modelScene);

      tuneMaterials(modelScene);
      setupCantAssemblies();

      modelReady = true;
      applyCameraMode();
      updateGeometry();
      ui.loading.classList.add('hidden');
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
    modelMeshes.push(obj);

    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of materials) {
      if (!mat) continue;
      mat.side = THREE.DoubleSide;
      mat.transparent = true;
      if ('metalness' in mat) mat.metalness = Math.min(mat.metalness ?? 0, 0.28);
      if ('roughness' in mat) mat.roughness = Math.max(mat.roughness ?? 0.45, 0.28);
      mat.needsUpdate = true;
    }
  });
  applyModelOpacity();
  applyWireframe();
}

function setupCantAssemblies() {
  modelScene.updateMatrixWorld(true);

  portCantGroup = modelScene.getObjectByName('PORT_FOIL_CANT_ROOT');
  stbdCantGroup = modelScene.getObjectByName('STBD_FOIL_CANT_ROOT');

  if (!portCantGroup || !stbdCantGroup) {
    throw new Error('Foil cant roots are missing from ac40-model.gltf');
  }

  portFoilMarker = new THREE.Object3D();
  portFoilMarker.position.set(
    6.449 - 6.911853,
    -2.266 - 0.35055,
    -3.06043 - (-1.38623)
  );
  portCantGroup.add(portFoilMarker);

  stbdFoilMarker = new THREE.Object3D();
  stbdFoilMarker.position.set(
    6.449 - 6.911853,
    -2.271 - 0.35055,
    3.06043 - 1.38292
  );
  stbdCantGroup.add(stbdFoilMarker);
}

function bindUI() {
  bindRange(ui.cantPort, ui.cantPortValue, (v) => { state.cantPort = v; return `${v.toFixed(1)}°`; });
  bindRange(ui.cantStbd, ui.cantStbdValue, (v) => { state.cantStbd = v; return `${v.toFixed(1)}°`; });
  bindRange(ui.heel, ui.heelValue, (v) => { state.heel = v; return `${signed(v, 1)}°`; });
  bindRange(ui.trim, ui.trimValue, (v) => { state.trim = v; return `${signed(v, 1)}°`; });
  bindRange(ui.ridePosition, ui.ridePositionValue, (v) => { state.ridePosition = v; return `${signed(v, 2)} m`; });

  bindRange(ui.camAlong, ui.camAlongValue, (v) => { state.camAlong = v; return `${signed(v, 2)} m`; });
  bindRange(ui.camHeight, ui.camHeightValue, (v) => { state.camHeight = v; return `${signed(v, 2)} m`; });
  bindRange(ui.camAthwart, ui.camAthwartValue, (v) => { state.camAthwart = v; return `${signed(v, 2)} m`; });
  bindRange(ui.camPan, ui.camPanValue, (v) => { state.camPan = v; return `${signed(v, 1)}°`; });
  bindRange(ui.camTilt, ui.camTiltValue, (v) => { state.camTilt = v; return `${signed(v, 1)}°`; });

  ui.camFov.addEventListener('input', () => {
    state.camFov = Number(ui.camFov.value);
    ui.camFovValue.textContent = `${state.camFov.toFixed(0)}°`;
    camera.fov = state.camFov;
    camera.updateProjectionMatrix();
  });

  ui.modelOpacity.addEventListener('input', () => {
    ui.modelOpacityValue.textContent = `${ui.modelOpacity.value}%`;
    applyModelOpacity();
  });

  ui.wireframeToggle.addEventListener('change', applyWireframe);

  ui.waterlineToggle.addEventListener('change', () => {
    const visible = ui.waterlineToggle.checked;
    waterPlane.visible = visible;
    waterGrid.visible = visible;
  });

  document.querySelectorAll('#cameraMode button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#cameraMode button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      state.cameraMode = button.dataset.mode;
      ui.onboardPresets.hidden = state.cameraMode !== 'onboard';
      ui.externalPresets.hidden = state.cameraMode === 'onboard';
      ui.onboardControls.hidden = state.cameraMode !== 'onboard';
      controls.enabled = state.cameraMode === 'external';
      ui.cameraHint.textContent = state.cameraMode === 'onboard'
        ? 'Onboard mode keeps the camera bolted to the hull — it follows heel, trim and ride height automatically. Use the sliders to nudge the mount position and aim.'
        : 'Drag to orbit, scroll to zoom. External mode is a free camera in space — for a chase-boat, drone or TV shot rather than a boat-mounted one.';
      applyCameraMode();
    });
  });

  document.querySelectorAll('#onboardPresets .preset-button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#onboardPresets .preset-button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      applyOnboardPreset(button.dataset.preset);
    });
  });

  document.querySelectorAll('#externalPresets .preset-button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#externalPresets .preset-button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      applyExternalPreset(button.dataset.view);
    });
  });

  ui.photoInput.addEventListener('change', onPhotoSelected);

  ui.resetBtn.addEventListener('click', resetAll);
}

function bindRange(input, output, setter) {
  input.addEventListener('input', () => {
    const value = Number(input.value);
    output.textContent = setter(value);
    if (modelReady) updateGeometry();
  });
}

function onPhotoSelected(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      ui.photoLayer.style.backgroundImage = `url("${reader.result}")`;
      ui.viewportBox.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      ui.photoFileName.textContent = file.name;
      onResize();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function applyOnboardPreset(name) {
  const preset = ONBOARD_PRESETS[name];
  if (!preset) return;
  state.camAlong = preset.along;
  state.camHeight = preset.height;
  state.camAthwart = preset.athwart;
  state.camPan = preset.pan;
  state.camTilt = preset.tilt;

  ui.camAlong.value = preset.along; ui.camAlongValue.textContent = `${signed(preset.along, 2)} m`;
  ui.camHeight.value = preset.height; ui.camHeightValue.textContent = `${signed(preset.height, 2)} m`;
  ui.camAthwart.value = preset.athwart; ui.camAthwartValue.textContent = `${signed(preset.athwart, 2)} m`;
  ui.camPan.value = preset.pan; ui.camPanValue.textContent = `${signed(preset.pan, 1)}°`;
  ui.camTilt.value = preset.tilt; ui.camTiltValue.textContent = `${signed(preset.tilt, 1)}°`;

  if (modelReady) updateGeometry();
}

function applyExternalPreset(view) {
  const position = EXTERNAL_PRESETS[view];
  if (!position) return;
  camera.position.copy(position);
  controls.target.copy(EXTERNAL_TARGET);
  controls.update();
}

function applyCameraMode() {
  if (!modelReady) return;

  if (state.cameraMode === 'onboard') {
    if (camera.parent !== boatRoot) boatRoot.add(camera);
    controls.enabled = false;
    updateOnboardCamera();
  } else {
    if (camera.parent !== scene) scene.add(camera);
    controls.enabled = true;
    applyExternalPreset('beam');
  }
}

function updateOnboardCamera() {
  const pos = ONBOARD_BASE.clone();
  pos.x += state.camAlong;
  pos.y += state.camHeight;
  pos.z += state.camAthwart;
  camera.position.copy(pos);

  // Base heading looks toward the stern (-X, toward the mast/cockpit), since
  // the rig is mounted near the bow looking aft-and-across — matching a
  // typical broadcast bow camera. Pan/tilt sliders offset from there.
  camera.rotation.order = 'YXZ';
  camera.rotation.set(
    THREE.MathUtils.degToRad(state.camTilt),
    THREE.MathUtils.degToRad(90 + state.camPan),
    0
  );
}

function updateGeometry() {
  if (!modelReady) return;

  portCantGroup.rotation.x = THREE.MathUtils.degToRad(state.cantPort - MODEL_CANT_REFERENCE);
  stbdCantGroup.rotation.x = -THREE.MathUtils.degToRad(state.cantStbd - MODEL_CANT_REFERENCE);

  boatRoot.rotation.set(
    THREE.MathUtils.degToRad(state.heel),
    0,
    THREE.MathUtils.degToRad(state.trim),
    'XYZ'
  );
  boatRoot.position.set(0, state.ridePosition, 0);
  boatRoot.updateMatrixWorld(true);

  if (state.cameraMode === 'onboard') updateOnboardCamera();

  updateOutputs();
}

function updateOutputs() {
  boatRoot.updateMatrixWorld(true);

  portFoilMarker.getWorldPosition(tempV);
  const sinkPort = tempV.y;
  stbdFoilMarker.getWorldPosition(tempV);
  const sinkStbd = tempV.y;

  ui.outCantPort.textContent = `${state.cantPort.toFixed(1)}°`;
  ui.outCantStbd.textContent = `${state.cantStbd.toFixed(1)}°`;
  ui.outSinkPort.textContent = formatSignedMeters(sinkPort);
  ui.outSinkStbd.textContent = formatSignedMeters(sinkStbd);
}

function applyModelOpacity() {
  const opacity = Number(ui.modelOpacity.value) / 100;
  for (const mesh of modelMeshes) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      mat.opacity = opacity;
      mat.needsUpdate = true;
    }
  }
}

function applyWireframe() {
  const on = ui.wireframeToggle.checked;
  for (const mesh of modelMeshes) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      mat.wireframe = on;
      mat.needsUpdate = true;
    }
  }
}

function resetAll() {
  Object.assign(state, {
    cantPort: defaults.cantPort,
    cantStbd: defaults.cantStbd,
    heel: defaults.heel,
    trim: defaults.trim,
    ridePosition: defaults.ridePosition
  });

  ui.cantPort.value = defaults.cantPort; ui.cantPortValue.textContent = `${defaults.cantPort.toFixed(1)}°`;
  ui.cantStbd.value = defaults.cantStbd; ui.cantStbdValue.textContent = `${defaults.cantStbd.toFixed(1)}°`;
  ui.heel.value = defaults.heel; ui.heelValue.textContent = `${signed(defaults.heel, 1)}°`;
  ui.trim.value = defaults.trim; ui.trimValue.textContent = `${signed(defaults.trim, 1)}°`;
  ui.ridePosition.value = defaults.ridePosition; ui.ridePositionValue.textContent = `${signed(defaults.ridePosition, 2)} m`;

  applyOnboardPreset('bow-leeward');
  document.querySelectorAll('#onboardPresets .preset-button').forEach((b) => b.classList.toggle('active', b.dataset.preset === 'bow-leeward'));

  if (modelReady) updateGeometry();
}

function signed(value, decimals = 1) {
  const n = Number(value).toFixed(decimals);
  return value > 0 ? `+${n}` : n;
}

function formatSignedMeters(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)} m`;
}

function onResize() {
  if (!renderer || !camera) return;
  const width = Math.max(1, ui.scene.clientWidth);
  const height = Math.max(1, ui.scene.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  if (modelReady) renderer.render(scene, camera);
}
