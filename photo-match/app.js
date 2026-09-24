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
  photoImg: $('photoImg'),
  photoInput: $('photoInput'),
  photoFileName: $('photoFileName'),
  resetPhotoBtn: $('resetPhotoBtn'),
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
  cameraHint: $('cameraHint'),

  saveMatchBtn: $('saveMatchBtn'),
  matchLogList: $('matchLogList'),
  matchLogCount: $('matchLogCount'),
  downloadAllBtn: $('downloadAllBtn')
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
  camPan: 0,
  camTilt: -4,
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
  camFov: defaults.camFov,

  // Reference-photo pan/zoom, set by dragging/scrolling the photo directly
  // in the viewer (onboard mode only). Independent of the Reset button ÃÂ¢ÃÂÃÂ
  // resetting the boat/camera calibration shouldn't throw away photo
  // alignment work.
  photoOffsetX: 0,
  photoOffsetY: 0,
  photoScale: 1
};

// Onboard rig base position, in boat-local coordinates (X = fore/aft,
// bow at larger X; Y = up; Z = athwartships, starboard positive). Derived
// from the hull's bounding box (bow tip near X=11.8, deck near Y=1.0 at the
// bow) plus a real-world estimate of the mount: 1.15m out beyond the bow
// (on the bowsprit) and 0.38m above the deck there ÃÂ¢ÃÂÃÂ matching a bolted-on
// bow cam mounted as far forward as the boat allows. There is only one
// physical bow camera (it doesn't move between tacks), so there's only one
// onboard "Bow" preset below, not a leeward/windward pair.
const ONBOARD_BASE = new THREE.Vector3(12.95, 1.38, 0);

const ONBOARD_PRESETS = {
  'bow': { along: 0, height: 0, athwart: 0, pan: 0, tilt: -4 },
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

const MATCH_LOG_KEY = 'seagull-photomatch-log-v1';
let matchLog = [];

let renderer, scene, camera, controls;
let boatRoot, modelScene, portCantGroup, stbdCantGroup;
let portFoilMarker, stbdFoilMarker;
let waterPlane, waterGrid;
let modelReady = false;
let modelMeshes = [];
let photoLoaded = false;

const tempV = new THREE.Vector3();

initScene();
bindUI();
loadMatchLog();
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

  // Lower ambient fill so the directional lights below do the work of
  // revealing hull shape (bow taper, deck curvature, foil arms) instead of
  // washing everything to a flat, even brightness.
  scene.add(new THREE.HemisphereLight(0xb8e7f2, 0x04101a, 1.35));

  // Key light: raking angle from high off the bow/starboard side. Bright
  // enough to throw a clear light/shadow gradient along the hull length so
  // bow vs. stern is obvious even at reduced model opacity.
  const key = new THREE.DirectionalLight(0xffffff, 4.6);
  key.position.set(7, 13, 9);
  scene.add(key);

  // Fill light from the stern/port side keeps that side of the hull from
  // going fully black without flattening the key light's contrast.
  const fill = new THREE.DirectionalLight(0xcfe9ff, 1.1);
  fill.position.set(-6, 5, -6);
  scene.add(fill);

  // Cyan rim light traces the stern contour Ã¢ÂÂ a second, colour-coded cue
  // for which end is the stern even in silhouette.
  const rim = new THREE.DirectionalLight(0x47e7db, 2.0);
  rim.position.set(-9, 2, -12);
  scene.add(rim);

  // Nose fill: stationed out ahead of the bow, shining back along the
  // hull. The bow-mounted onboard camera looks almost straight down the
  // boat's own forward axis, so it mostly sees the hull's forward and
  // underside surfaces â exactly the faces the overhead key light barely
  // reaches. Without this they render as a near-black silhouette.
  const nose = new THREE.DirectionalLight(0xdfeeff, 3.2);
  nose.position.set(20, 3, 2);
  scene.add(nose);

  createWaterGuide();

  window.addEventListener('resize', onResize);
  onResize();
}

function createWaterGuide() {
  const geometry = new THREE.PlaneGeometry(60, 46, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    color: 0x1c5876,
    transparent: true,
    opacity: 0.26,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  waterPlane = new THREE.Mesh(geometry, material);
  waterPlane.position.set(6, 0, 0);
  scene.add(waterPlane);

  // Brighter, higher-contrast grid than the water plane alone so the sea
  // level is easy to read against a loaded reference photo, not just a
  // faint tint. Center lines (boat's own X/Z axes through the origin) are
  // brighter still so the waterline reference is unambiguous.
  waterGrid = new THREE.GridHelper(60, 30, 0x9dfff2, 0x4a90b8);
  waterGrid.position.set(6, 0.006, 0);
  waterGrid.material.transparent = true;
  waterGrid.material.opacity = 0.5;
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
      if ('roughness' in mat) mat.roughness = Math.max(mat.roughness ?? 0.45, 0.22);
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
  bindRange(ui.cantPort, ui.cantPortValue, (v) => { state.cantPort = v; return `${v.toFixed(1)}ÃÂÃÂ°`; });
  bindRange(ui.cantStbd, ui.cantStbdValue, (v) => { state.cantStbd = v; return `${v.toFixed(1)}ÃÂÃÂ°`; });
  bindRange(ui.heel, ui.heelValue, (v) => { state.heel = v; return `${signed(v, 1)}ÃÂÃÂ°`; });
  bindRange(ui.trim, ui.trimValue, (v) => { state.trim = v; return `${signed(v, 1)}ÃÂÃÂ°`; });
  bindRange(ui.ridePosition, ui.ridePositionValue, (v) => { state.ridePosition = v; return `${signed(v, 2)} m`; });

  bindRange(ui.camAlong, ui.camAlongValue, (v) => { state.camAlong = v; return `${signed(v, 2)} m`; });
  bindRange(ui.camHeight, ui.camHeightValue, (v) => { state.camHeight = v; return `${signed(v, 2)} m`; });
  bindRange(ui.camAthwart, ui.camAthwartValue, (v) => { state.camAthwart = v; return `${signed(v, 2)} m`; });
  bindRange(ui.camPan, ui.camPanValue, (v) => { state.camPan = v; return `${signed(v, 1)}ÃÂÃÂ°`; });
  bindRange(ui.camTilt, ui.camTiltValue, (v) => { state.camTilt = v; return `${signed(v, 1)}ÃÂÃÂ°`; });

  ui.camFov.addEventListener('input', () => {
    state.camFov = Number(ui.camFov.value);
    ui.camFovValue.textContent = `${state.camFov.toFixed(0)}ÃÂÃÂ°`;
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
      ui.viewportBox.classList.toggle('photo-draggable', state.cameraMode === 'onboard');
      ui.cameraHint.textContent = state.cameraMode === 'onboard'
        ? 'Onboard mode keeps the camera bolted to the hull ÃÂ¢ÃÂÃÂ it follows heel, trim and ride height automatically. Use the sliders to nudge the mount position and aim.'
        : 'Drag to orbit, scroll to zoom. External mode is a free camera in space ÃÂ¢ÃÂÃÂ for a chase-boat, drone or TV shot rather than a boat-mounted one.';
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

  ui.saveMatchBtn.addEventListener('click', saveMatch);
  ui.downloadAllBtn.addEventListener('click', downloadAllMatches);

  bindPhotoInteraction();
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
      ui.photoImg.src = reader.result;
      ui.viewportBox.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      ui.photoFileName.textContent = file.name;

      // A freshly loaded photo starts centred and unzoomed; the reference
      // photo's own aspect ratio already matches the viewport, so this is
      // an exact fit before the user drags/scrolls to fine-tune it.
      state.photoOffsetX = 0;
      state.photoOffsetY = 0;
      state.photoScale = 1;
      applyPhotoTransform();

      photoLoaded = true;
      ui.photoLayer.classList.add('has-photo');
      ui.viewportBox.classList.add('has-photo');
      onResize();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function applyPhotoTransform() {
  ui.photoImg.style.transform =
    `translate(${state.photoOffsetX}px, ${state.photoOffsetY}px) scale(${state.photoScale})`;
}

function resetPhotoTransform() {
  state.photoOffsetX = 0;
  state.photoOffsetY = 0;
  state.photoScale = 1;
  applyPhotoTransform();
}

// Drag directly on the viewer to reposition the reference photo, scroll to
// zoom it. Only active in onboard mode (external mode's OrbitControls owns
// drag/scroll there instead) and only once a photo is loaded. Listening on
// viewportBox rather than the photo layer itself means this still works
// even though the WebGL canvas sits on top and receives the raw event
// first ÃÂ¢ÃÂÃÂ mousedown/wheel bubble up to this ancestor either way.
let photoDrag = null;

function bindPhotoInteraction() {
  ui.viewportBox.addEventListener('mousedown', (e) => {
    if (state.cameraMode !== 'onboard' || !photoLoaded) return;
    photoDrag = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: state.photoOffsetX,
      baseY: state.photoOffsetY
    };
    ui.viewportBox.classList.add('dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!photoDrag) return;
    state.photoOffsetX = photoDrag.baseX + (e.clientX - photoDrag.startX);
    state.photoOffsetY = photoDrag.baseY + (e.clientY - photoDrag.startY);
    applyPhotoTransform();
  });

  window.addEventListener('mouseup', () => {
    if (!photoDrag) return;
    photoDrag = null;
    ui.viewportBox.classList.remove('dragging');
  });

  ui.viewportBox.addEventListener('wheel', (e) => {
    if (state.cameraMode !== 'onboard' || !photoLoaded) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    state.photoScale = Math.min(4, Math.max(0.4, state.photoScale * factor));
    applyPhotoTransform();
  }, { passive: false });

  ui.resetPhotoBtn.addEventListener('click', resetPhotoTransform);
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
  ui.camPan.value = preset.pan; ui.camPanValue.textContent = `${signed(preset.pan, 1)}ÃÂÃÂ°`;
  ui.camTilt.value = preset.tilt; ui.camTiltValue.textContent = `${signed(preset.tilt, 1)}ÃÂÃÂ°`;

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
  // the rig is mounted near the bow looking aft-and-across ÃÂ¢ÃÂÃÂ matching a
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

  ui.outCantPort.textContent = `${state.cantPort.toFixed(1)}ÃÂÃÂ°`;
  ui.outCantStbd.textContent = `${state.cantStbd.toFixed(1)}ÃÂÃÂ°`;
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

  ui.cantPort.value = defaults.cantPort; ui.cantPortValue.textContent = `${defaults.cantPort.toFixed(1)}ÃÂÃÂ°`;
  ui.cantStbd.value = defaults.cantStbd; ui.cantStbdValue.textContent = `${defaults.cantStbd.toFixed(1)}ÃÂÃÂ°`;
  ui.heel.value = defaults.heel; ui.heelValue.textContent = `${signed(defaults.heel, 1)}ÃÂÃÂ°`;
  ui.trim.value = defaults.trim; ui.trimValue.textContent = `${signed(defaults.trim, 1)}ÃÂÃÂ°`;
  ui.ridePosition.value = defaults.ridePosition; ui.ridePositionValue.textContent = `${signed(defaults.ridePosition, 2)} m`;

  applyOnboardPreset('bow');
  document.querySelectorAll('#onboardPresets .preset-button').forEach((b) => b.classList.toggle('active', b.dataset.preset === 'bow'));

  if (modelReady) updateGeometry();
}

function signed(value, decimals = 1) {
  const n = Number(value).toFixed(decimals);
  return value > 0 ? `+${n}` : n;
}

function formatSignedMeters(value) {
  if (!Number.isFinite(value)) return 'ÃÂ¢ÃÂÃÂ';
  return `${value < 0 ? 'ÃÂ¢ÃÂÃÂ' : ''}${Math.abs(value).toFixed(2)} m`;
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
  // Only let OrbitControls drive the camera in external mode. It recomputes
  // camera position/rotation from its own internal target/spherical state on
  // every call, which was silently overriding the onboard rig's manual
  // pan/tilt rotation from updateOnboardCamera() each frame.
  if (controls.enabled) controls.update();
  if (modelReady) renderer.render(scene, camera);
}

// ---------------------------------------------------------------------
// Saved matches: capture the current photo + model overlay as one PNG
// (with the four headline numbers burned into a caption bar) and keep a
// running list of them in the page, so several photos can be worked
// through before sending the results out.
// ---------------------------------------------------------------------

function loadMatchLog() {
  try {
    const raw = localStorage.getItem(MATCH_LOG_KEY);
    matchLog = raw ? JSON.parse(raw) : [];
  } catch (err) {
    matchLog = [];
  }
  renderMatchLog();
}

function persistMatchLog() {
  try {
    localStorage.setItem(MATCH_LOG_KEY, JSON.stringify(matchLog));
  } catch (err) {
    // Storage full or unavailable ÃÂ¢ÃÂÃÂ the in-page list still works for this
    // session, it just won't survive a reload. Not fatal either way.
    console.warn('Could not persist match log', err);
  }
}

function renderMatchLog() {
  ui.matchLogCount.textContent = matchLog.length === 1 ? '1 saved' : `${matchLog.length} saved`;
  ui.downloadAllBtn.hidden = matchLog.length === 0;
  ui.matchLogList.innerHTML = '';

  for (const entry of matchLog) {
    const item = document.createElement('div');
    item.className = 'match-log-item';
    item.dataset.id = entry.id;

    const thumb = document.createElement('img');
    thumb.className = 'match-log-thumb';
    thumb.src = entry.dataURL;
    thumb.alt = '';
    item.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'match-log-meta';

    const label = document.createElement('strong');
    label.className = 'match-log-label';
    label.textContent = entry.label;
    meta.appendChild(label);

    const nums = document.createElement('span');
    nums.className = 'match-log-nums';
    nums.textContent = `CP ${entry.cantPort} ÃÂÃÂ· CS ${entry.cantStbd} ÃÂÃÂ· SP ${entry.sinkPort} ÃÂÃÂ· SS ${entry.sinkStbd}`;
    meta.appendChild(nums);

    item.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'match-log-actions';

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.title = 'Download this match';
    dlBtn.textContent = 'ÃÂ¢ÃÂÃÂ';
    dlBtn.addEventListener('click', () => downloadMatchEntry(entry));
    actions.appendChild(dlBtn);

    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'match-log-remove';
    rmBtn.title = 'Remove this match';
    rmBtn.textContent = 'ÃÂÃÂ';
    rmBtn.addEventListener('click', () => removeMatchEntry(entry.id));
    actions.appendChild(rmBtn);

    item.appendChild(actions);
    ui.matchLogList.appendChild(item);
  }
}

function removeMatchEntry(id) {
  matchLog = matchLog.filter((e) => e.id !== id);
  persistMatchLog();
  renderMatchLog();
}

function downloadMatchEntry(entry) {
  const a = document.createElement('a');
  a.href = entry.dataURL;
  a.download = `${entry.filenameBase}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function sanitizeFilename(name) {
  const cleaned = (name || 'photo-match').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'photo-match';
}

// Renders the current photo (with its drag/zoom transform) and the WebGL
// model overlay into one canvas, exactly as they're stacked in the viewer,
// plus a caption bar with the four headline numbers burned in so the image
// is self-contained once it's sent elsewhere.
function captureMatchSnapshot() {
  const rect = ui.viewportBox.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const captionHeight = 54;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height + captionHeight;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#030a12';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (photoLoaded && ui.photoImg.complete && ui.photoImg.naturalWidth) {
    const img = ui.photoImg;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const containerAspect = width / height;
    const imageAspect = iw / ih;
    let drawW, drawH;
    if (imageAspect > containerAspect) {
      drawH = height;
      drawW = height * imageAspect;
    } else {
      drawW = width;
      drawH = width / imageAspect;
    }
    const drawX = (width - drawW) / 2;
    const drawY = (height - drawH) / 2;

    const cx = width / 2;
    const cy = height / 2;
    ctx.save();
    ctx.translate(cx + state.photoOffsetX, cy + state.photoOffsetY);
    ctx.scale(state.photoScale, state.photoScale);
    ctx.translate(-cx, -cy);
    ctx.drawImage(img, drawX, drawY, drawW, drawH);
    ctx.restore();
  }

  if (renderer && modelReady) {
    renderer.render(scene, camera);
    ctx.drawImage(renderer.domElement, 0, 0, width, height);
  }

  ctx.fillStyle = 'rgba(6,16,27,0.88)';
  ctx.fillRect(0, height, width, captionHeight);
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#edf5fb';
  ctx.font = '600 14px Inter, ui-sans-serif, sans-serif';
  const line1 = `Cant  P ${state.cantPort.toFixed(1)}ÃÂÃÂ°   S ${state.cantStbd.toFixed(1)}ÃÂÃÂ°`;
  ctx.fillText(line1, 14, height + captionHeight / 2 - 11);

  ctx.fillStyle = '#8fa2b5';
  ctx.font = '400 12px Inter, ui-sans-serif, sans-serif';
  const line2 = `Sink  P ${ui.outSinkPort.textContent}   S ${ui.outSinkStbd.textContent}`;
  ctx.fillText(line2, 14, height + captionHeight / 2 + 11);

  return canvas.toDataURL('image/png');
}

function saveMatch() {
  const dataURL = captureMatchSnapshot();
  const labelSource = photoLoaded ? ui.photoFileName.textContent : 'no photo';
  const stamp = new Date();
  const baseName = sanitizeFilename(labelSource.replace(/\.[a-z0-9]+$/i, ''));
  const filenameBase = `${baseName}-${stamp.getTime()}`;

  const entry = {
    id: `${stamp.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    label: labelSource,
    timestamp: stamp.toLocaleString(),
    cantPort: `${state.cantPort.toFixed(1)}ÃÂÃÂ°`,
    cantStbd: `${state.cantStbd.toFixed(1)}ÃÂÃÂ°`,
    sinkPort: ui.outSinkPort.textContent,
    sinkStbd: ui.outSinkStbd.textContent,
    filenameBase,
    dataURL
  };

  matchLog.unshift(entry);
  persistMatchLog();
  renderMatchLog();
}

function downloadAllMatches() {
  if (!matchLog.length) return;

  matchLog.forEach((entry, i) => {
    setTimeout(() => downloadMatchEntry(entry), i * 250);
  });

  const header = ['label', 'timestamp', 'cant_port', 'cant_stbd', 'sink_port', 'sink_stbd'];
  const rows = matchLog.map((e) => [e.label, e.timestamp, e.cantPort, e.cantStbd, e.sinkPort, e.sinkStbd]);
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  setTimeout(() => {
    const a = document.createElement('a');
    a.href = url;
    a.download = `photo-match-log-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, matchLog.length * 250 + 200);
}
