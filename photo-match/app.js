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

  calibBlockHint: $('calibBlockHint'),
  calibModeSpan: $('calibModeSpan'),
  calibModeSingle: $('calibModeSingle'),
  calibSideRow: $('calibSideRow'),
  calibSidePort: $('calibSidePort'),
  calibSideStbd: $('calibSideStbd'),
  calibMarkPort: $('calibMarkPort'),
  calibMarkStbd: $('calibMarkStbd'),
  calibMarkPortLabel: $('calibMarkPortLabel'),
  calibMarkStbdLabel: $('calibMarkStbdLabel'),
  calibSolveBtn: $('calibSolveBtn'),
  calibClearBtn: $('calibClearBtn'),
  calibHint: $('calibHint'),
  calibPinLayer: $('calibPinLayer'),
  calibLoupe: $('calibLoupe'),

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
  // in the viewer (onboard mode only). Independent of the Reset button —
  // resetting the boat/camera calibration shouldn't throw away photo
  // alignment work.
  photoOffsetX: 0,
  photoOffsetY: 0,
  photoScale: 1,

  // Foil-span calibration: two click-placed pins on the reference photo,
  // each stored as a fraction of the photo image's own displayed rect (so
  // they track it through drag/zoom, same trick as the photo transform
  // itself), plus which pin (if any) the next viewport click will place.
  //
  // calibMode 'span' is the original mode: both foils are visible in the
  // photo, and the two pins are the port tip and the starboard tip. Mode
  // 'single' is for a photo showing only one foil (e.g. cropped, or the
  // other side out of frame): both pins are placed on that SAME foil, one
  // at the knuckle (where the strut bends into the horizontal tip section
  // -- the existing port/stbd foil marker already sits there) and one at
  // the true outer tip. calibSingleSide picks which foil is in the photo.
  calibPortPx: null,
  calibStbdPx: null,
  calibPicking: null,
  calibMode: 'span',
  calibSingleSide: 'port'
};

// Onboard rig base position, in boat-local coordinates (X = fore/aft,
// bow at larger X; Y = up; Z = athwartships, starboard positive). Derived
// from the hull's bounding box (bow tip near X=11.8, deck near Y=1.0 at the
// bow) plus a real-world estimate of the mount: 1.15m out beyond the bow
// (on the bowsprit) and 0.38m above the deck there — matching a bolted-on
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
let portFoilTrueTip, stbdFoilTrueTip;
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

  // Cyan rim light traces the stern contour — a second, colour-coded cue
  // for which end is the stern even in silhouette.
  const rim = new THREE.DirectionalLight(0x47e7db, 2.0);
  rim.position.set(-9, 2, -12);
  scene.add(rim);

  // Nose fill: stationed out ahead of the bow, shining back along the
  // hull. The bow-mounted onboard camera looks almost straight down the
  // boat's own forward axis, so it mostly sees the hull's forward and
  // underside surfaces — exactly the faces the overhead key light barely
  // reaches.
  const nose = new THREE.DirectionalLight(0xdfeeff, 2.4);
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

      // Several hull/rudder surfaces in the GLTF are baked pure black
      // (0x000000). A perfectly black diffuse colour reflects none of the
      // scene lighting no matter how bright it is — that's why the bow
      // view looked like a flat silhouette regardless of light intensity.
      // Lift very dark colours to a minimum lightness so they still read
      // as a dark hull while actually responding to the lights above.
      if (mat.color) {
        const hsl = { h: 0, s: 0, l: 0 };
        mat.color.getHSL(hsl);
        if (hsl.l < 0.16) {
          mat.color.setHSL(hsl.h, hsl.s, 0.16);
        }
      }

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

  // True outer tip of each foil (the actual end of the mesh, further out
  // than the knuckle markers above), for single-foil calibration -- see
  // state.calibMode. Derived from the GLTF's own tip-region vertices.
  portFoilTrueTip = new THREE.Object3D();
  portFoilTrueTip.position.set(
    6.465 - 6.911853,
    -2.265 - 0.35055,
    -4.581 - (-1.38623)
  );
  portCantGroup.add(portFoilTrueTip);

  stbdFoilTrueTip = new THREE.Object3D();
  stbdFoilTrueTip.position.set(
    6.465 - 6.911853,
    -2.270 - 0.35055,
    4.550 - 1.38292
  );
  stbdCantGroup.add(stbdFoilTrueTip);
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

  ui.calibMarkPort.addEventListener('click', () => startCalibPick('port'));
  ui.calibMarkStbd.addEventListener('click', () => startCalibPick('stbd'));
  ui.calibSolveBtn.addEventListener('click', solveCalibration);
  ui.calibClearBtn.addEventListener('click', clearCalibPins);

  if (ui.calibModeSpan && ui.calibModeSingle) {
    ui.calibModeSpan.addEventListener('click', () => setCalibMode('span'));
    ui.calibModeSingle.addEventListener('click', () => setCalibMode('single'));
    ui.calibSidePort.addEventListener('click', () => setCalibSingleSide('port'));
    ui.calibSideStbd.addEventListener('click', () => setCalibSingleSide('stbd'));
    updateCalibModeUI();
  }

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
      if (state.cameraMode !== 'onboard') cancelCalibPicking();
      controls.enabled = state.cameraMode === 'external';
      ui.viewportBox.classList.toggle('photo-draggable', state.cameraMode === 'onboard');
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

      clearCalibPins();

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
  renderCalibPins();
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
// first — mousedown/wheel bubble up to this ancestor either way.
let photoDrag = null;

function bindPhotoInteraction() {
  ui.viewportBox.addEventListener('mousedown', (e) => {
    if (state.cameraMode !== 'onboard' || !photoLoaded) return;

    if (state.calibPicking) {
      const photoRect = ui.photoImg.getBoundingClientRect();
      const fx = (e.clientX - photoRect.left) / photoRect.width;
      const fy = (e.clientY - photoRect.top) / photoRect.height;
      placeCalibPin(state.calibPicking, fx, fy);
      e.preventDefault();
      return;
    }

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

  ui.viewportBox.addEventListener('mousemove', (e) => {
    if (!state.calibPicking || !photoLoaded) return;
    const photoRect = ui.photoImg.getBoundingClientRect();
    const fx = (e.clientX - photoRect.left) / photoRect.width;
    const fy = (e.clientY - photoRect.top) / photoRect.height;
    positionCalibLoupe(e.clientX, e.clientY, fx, fy);
  });

  ui.viewportBox.addEventListener('mouseleave', () => {
    if (state.calibPicking) hideCalibLoupe();
  });

  ui.resetPhotoBtn.addEventListener('click', resetPhotoTransform);
}

// ---------------------------------------------------------------------
// Foil-span calibration: mark the port and starboard foil tips on the
// loaded photo, then solve for the onboard camera's fore-aft mount
// position (camAlong) that makes the model's own foil-tip markers
// project to the same on-screen span. FOV and the other mount offsets
// stay fixed -- 100 degrees is the real lens spec, so fore-aft position
// is the one unknown this tool solves for.
// ---------------------------------------------------------------------

// Text for what pin "port" and pin "stbd" mean right now -- in 'span' mode
// they're literally the port/starboard foil tips; in 'single' mode both
// pins are on the one visible foil, so they're relabelled knuckle/outer tip.
function calibPinLabel(which) {
  if (state.calibMode === 'single') {
    return which === 'port' ? 'knuckle' : 'outer tip';
  }
  return which === 'port' ? 'port foil tip' : 'starboard foil tip';
}

function startCalibPick(which) {
  if (state.cameraMode !== 'onboard' || !photoLoaded) return;
  state.calibPicking = which;
  ui.calibMarkPort.classList.toggle('active', which === 'port');
  ui.calibMarkStbd.classList.toggle('active', which === 'stbd');
  ui.viewportBox.classList.add('calib-picking');
  ui.calibHint.textContent = `Click the ${calibPinLabel(which)} on the photo.`;
}

function cancelCalibPicking() {
  if (!state.calibPicking) return;
  state.calibPicking = null;
  ui.calibMarkPort.classList.remove('active');
  ui.calibMarkStbd.classList.remove('active');
  ui.viewportBox.classList.remove('calib-picking');
  hideCalibLoupe();
}

// Magnifying loupe -- a small zoomed-in crop of the photo, centred on the
// cursor's current photo-fraction position, shown while a pin is being
// placed so the click can land on the exact pixel. Same pattern as the
// mast-calibration loupe on the RC44 site's Sail Shots tool.
function positionCalibLoupe(clientX, clientY, fx, fy) {
  if (!ui.calibLoupe || !ui.photoImg.naturalWidth) return;
  const boxRect = ui.viewportBox.getBoundingClientRect();
  let lx = clientX - boxRect.left + 20;
  let ly = clientY - boxRect.top - 170;
  if (ly < 0) ly = clientY - boxRect.top + 20;
  if (lx + 150 > boxRect.width) lx = clientX - boxRect.left - 170;
  ui.calibLoupe.style.left = `${lx}px`;
  ui.calibLoupe.style.top = `${ly}px`;
  ui.calibLoupe.classList.add('is-visible');

  const lctx = ui.calibLoupe.getContext('2d');
  lctx.clearRect(0, 0, 150, 150);

  // fx/fy are fractions of the photo's own displayed (dragged/zoomed) box,
  // the same coordinate space pin placement already uses. The viewport box
  // is set to the photo's own aspect ratio on load, so object-fit: cover
  // never crops it -- fx/fy map linearly onto the source bitmap regardless
  // of the photo's current pan/zoom transform.
  const zoom = 4;
  const srcW = 150 / zoom, srcH = 150 / zoom;
  const sx = fx * ui.photoImg.naturalWidth - srcW / 2;
  const sy = fy * ui.photoImg.naturalHeight - srcH / 2;
  lctx.imageSmoothingEnabled = false;
  lctx.drawImage(ui.photoImg, sx, sy, srcW, srcH, 0, 0, 150, 150);

  lctx.strokeStyle = 'rgba(255,255,255,.85)';
  lctx.lineWidth = 1;
  lctx.beginPath();
  lctx.moveTo(75, 0); lctx.lineTo(75, 150);
  lctx.moveTo(0, 75); lctx.lineTo(150, 75);
  lctx.stroke();
}

function hideCalibLoupe() {
  if (ui.calibLoupe) ui.calibLoupe.classList.remove('is-visible');
}

function placeCalibPin(which, fx, fy) {
  const px = { fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) };
  if (which === 'port') state.calibPortPx = px; else state.calibStbdPx = px;

  const bothPlaced = state.calibPortPx && state.calibStbdPx;
  ui.calibClearBtn.disabled = !(state.calibPortPx || state.calibStbdPx);
  ui.calibSolveBtn.disabled = !bothPlaced;

  if (bothPlaced) {
    // Both tips down -- stop picking and let the solve button take over.
    cancelCalibPicking();
    ui.calibHint.textContent = state.calibMode === 'single'
      ? 'Knuckle and outer tip marked. Click "Scale photo to match" to solve.'
      : 'Both tips marked. Click "Scale photo to match" to solve.';
  } else {
    // Chain straight into picking the other tip so the second click on the
    // photo places it too, instead of leaving picking mode off and letting
    // that click fall through to the photo-drag handler (which looked like
    // "only one pin ever appears").
    startCalibPick(which === 'port' ? 'stbd' : 'port');
  }

  renderCalibPins();
}

function clearCalibPins() {
  state.calibPortPx = null;
  state.calibStbdPx = null;
  cancelCalibPicking();
  ui.calibClearBtn.disabled = true;
  ui.calibSolveBtn.disabled = true;
  ui.calibHint.textContent = state.calibMode === 'single'
    ? 'Click a "Mark" button, then click that point on the photo. With both the knuckle and the outer tip marked, this scales and repositions the photo so that span lands exactly on the model\'s current foil.'
    : 'Click a "Mark" button, then click that foil tip on the photo. With both pins placed, this scales and repositions the photo so its marked span lands exactly on the model\'s current foil tips.';
  renderCalibPins();
}

// Switches between calibrating off both foil tips (photo shows the whole
// span) and calibrating off two points on a single foil (photo shows only
// one foil, e.g. cropped or the other side out of frame). Existing pins are
// cleared on a switch since they'd otherwise be reinterpreted against the
// wrong reference points.
function setCalibMode(mode) {
  if (state.calibMode === mode) return;
  state.calibMode = mode;
  clearCalibPins();
  updateCalibModeUI();
}

function setCalibSingleSide(side) {
  if (state.calibSingleSide === side) return;
  state.calibSingleSide = side;
  if (state.calibMode === 'single') clearCalibPins();
  updateCalibModeUI();
}

function updateCalibModeUI() {
  const single = state.calibMode === 'single';
  ui.calibModeSpan.classList.toggle('active', !single);
  ui.calibModeSingle.classList.toggle('active', single);
  ui.calibSideRow.classList.toggle('is-hidden', !single);
  ui.calibSidePort.classList.toggle('active', state.calibSingleSide === 'port');
  ui.calibSideStbd.classList.toggle('active', state.calibSingleSide === 'stbd');

  if (single) {
    const side = state.calibSingleSide === 'port' ? 'port' : 'starboard';
    ui.calibMarkPortLabel.textContent = 'Mark knuckle';
    ui.calibMarkStbdLabel.textContent = 'Mark outer tip';
    ui.calibBlockHint.textContent = `Only the ${side} foil is visible -- mark its knuckle (where the strut bends into the tip) and its outer tip to scale and anchor the photo.`;
  } else {
    ui.calibMarkPortLabel.textContent = 'Mark port tip';
    ui.calibMarkStbdLabel.textContent = 'Mark stbd tip';
    ui.calibBlockHint.textContent = 'Mark both foil tips on the photo to scale and anchor it to the model.';
  }
}

// Re-anchors the two pin dots to their stored fraction of the photo
// image's own on-screen rect, so they stay glued to the photo through
// drag/zoom and window resizes.
function renderCalibPins() {
  if (!ui.calibPinLayer) return;
  ui.calibPinLayer.innerHTML = '';
  if (!state.calibPortPx && !state.calibStbdPx) return;

  const boxRect = ui.viewportBox.getBoundingClientRect();
  const photoRect = ui.photoImg.getBoundingClientRect();
  if (!photoRect.width || !photoRect.height) return;

  const addPin = (px, cls) => {
    if (!px) return;
    const el = document.createElement('div');
    el.className = `calib-pin calib-pin--${cls}`;
    el.style.left = `${(photoRect.left - boxRect.left) + px.fx * photoRect.width}px`;
    el.style.top = `${(photoRect.top - boxRect.top) + px.fy * photoRect.height}px`;
    ui.calibPinLayer.appendChild(el);
  };
  addPin(state.calibPortPx, 'port');
  addPin(state.calibStbdPx, 'stbd');
}

// Converts a stored {fx, fy} pin (a fraction of the photo's own displayed
// rect) into a pixel position in the viewport-box's own coordinate frame
// -- the same frame the 3D scene renders into, since #scene and the photo
// layer are both absolutely positioned to fill the viewport box exactly.
function calibPinToBoxPx(px, boxRect, photoRect) {
  return {
    x: (photoRect.left - boxRect.left) + px.fx * photoRect.width,
    y: (photoRect.top - boxRect.top) + px.fy * photoRect.height
  };
}

function solveCalibration() {
  if (!modelReady || !state.calibPortPx || !state.calibStbdPx) return;

  const boxRect = ui.viewportBox.getBoundingClientRect();
  const boxWidth = boxRect.width;
  const boxHeight = boxRect.height;
  const photoRect = ui.photoImg.getBoundingClientRect();
  const portPx = calibPinToBoxPx(state.calibPortPx, boxRect, photoRect);
  const stbdPx = calibPinToBoxPx(state.calibStbdPx, boxRect, photoRect);
  const photoSpan = Math.hypot(stbdPx.x - portPx.x, stbdPx.y - portPx.y);
  if (photoSpan < 1) return;

  // The model's own foil-tip markers, projected through the onboard camera
  // exactly as it's currently set (fore-aft, height, pan, tilt) -- no
  // camera search here. We're scaling and repositioning the PHOTO to match
  // the model's current rendering, not moving the camera to match the
  // photo, so the camera stays exactly where the sliders above put it.
  boatRoot.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const portWorld = new THREE.Vector3();
  const stbdWorld = new THREE.Vector3();
  if (state.calibMode === 'single') {
    // Both pins are on the one visible foil: pin "port" = knuckle, pin
    // "stbd" = outer tip (see calibPinLabel), both taken from whichever
    // side's foil is actually in the photo.
    const knuckleMarker = state.calibSingleSide === 'port' ? portFoilMarker : stbdFoilMarker;
    const tipMarker = state.calibSingleSide === 'port' ? portFoilTrueTip : stbdFoilTrueTip;
    knuckleMarker.getWorldPosition(portWorld);
    tipMarker.getWorldPosition(stbdWorld);
  } else {
    portFoilMarker.getWorldPosition(portWorld);
    stbdFoilMarker.getWorldPosition(stbdWorld);
  }

  const projectToBoxPx = (worldPos) => {
    const p = worldPos.clone().project(camera);
    return {
      x: (p.x * 0.5 + 0.5) * boxWidth,
      y: (1 - (p.y * 0.5 + 0.5)) * boxHeight
    };
  };
  const modelPortPx = projectToBoxPx(portWorld);
  const modelStbdPx = projectToBoxPx(stbdWorld);
  const modelSpan = Math.hypot(modelStbdPx.x - modelPortPx.x, modelStbdPx.y - modelPortPx.y);
  const modelMid = {
    x: (modelPortPx.x + modelStbdPx.x) / 2,
    y: (modelPortPx.y + modelStbdPx.y) / 2
  };

  // Scale the photo so its marked span exactly matches the model's current
  // foil-tip span, then reposition it so the marked midpoint lands exactly
  // on the model's foil-tip midpoint -- a similarity fit (uniform scale +
  // translate) through those two reference points, the same idea as
  // anchoring a photo overlay to two known points.
  const oldScale = state.photoScale;
  const newScale = Math.min(4, Math.max(0.4, oldScale * (modelSpan / photoSpan)));

  // fx/fy fractions are invariant under the photo's own uniform scale +
  // translate transform, so this recovers the marked midpoint's position in
  // the photo's untransformed local box -- i.e. viewport-box coordinates
  // before any pan/zoom is applied. The transform is
  // translate(ox, oy) scale(s) about the box's own centre (transform-origin
  // 50% 50%), which places a local point p at
  // s * (p - centre) + (ox, oy) + centre -- solved below for (ox, oy) so
  // that point lands on the model's foil-tip midpoint.
  const localMidX = ((state.calibPortPx.fx + state.calibStbdPx.fx) / 2) * boxWidth;
  const localMidY = ((state.calibPortPx.fy + state.calibStbdPx.fy) / 2) * boxHeight;

  state.photoScale = newScale;
  state.photoOffsetX = modelMid.x - newScale * (localMidX - boxWidth / 2) - boxWidth / 2;
  state.photoOffsetY = modelMid.y - newScale * (localMidY - boxHeight / 2) - boxHeight / 2;
  applyPhotoTransform();

  const finalSpan = photoSpan * (newScale / oldScale);
  const clamped = Math.abs(finalSpan - modelSpan) > 1;
  ui.calibHint.textContent = clamped
    ? `Scaled photo to ${newScale.toFixed(2)}× (hit the zoom limit -- span now ${finalSpan.toFixed(0)}px vs model's ${modelSpan.toFixed(0)}px). Adjust cant/heel/trim or camera and solve again.`
    : `Scaled photo to ${newScale.toFixed(2)}× and anchored it to the model's foil tips (span ${finalSpan.toFixed(0)}px).`;
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

  applyOnboardPreset('bow');
  document.querySelectorAll('#onboardPresets .preset-button').forEach((b) => b.classList.toggle('active', b.dataset.preset === 'bow'));

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
  renderCalibPins();
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
    // Storage full or unavailable — the in-page list still works for this
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
    nums.textContent = `CP ${entry.cantPort} · CS ${entry.cantStbd} · SP ${entry.sinkPort} · SS ${entry.sinkStbd}`;
    meta.appendChild(nums);

    item.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'match-log-actions';

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.title = 'Download this match';
    dlBtn.textContent = '↓';
    dlBtn.addEventListener('click', () => downloadMatchEntry(entry));
    actions.appendChild(dlBtn);

    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'match-log-remove';
    rmBtn.title = 'Remove this match';
    rmBtn.textContent = '×';
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
  const line1 = `Cant  P ${state.cantPort.toFixed(1)}°   S ${state.cantStbd.toFixed(1)}°`;
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
    cantPort: `${state.cantPort.toFixed(1)}°`,
    cantStbd: `${state.cantStbd.toFixed(1)}°`,
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
