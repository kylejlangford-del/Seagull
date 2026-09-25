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
  movePhotoToggle: $('movePhotoToggle'),
  photoDragHint: $('photoDragHint'),
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
  calibModeFull: $('calibModeFull'),
  calibSideRow: $('calibSideRow'),
  calibSidePort: $('calibSidePort'),
  calibSideStbd: $('calibSideStbd'),
  calibPinRow: $('calibPinRow'),
  calibMarkPort: $('calibMarkPort'),
  calibMarkStbd: $('calibMarkStbd'),
  calibMarkPortLabel: $('calibMarkPortLabel'),
  calibMarkStbdLabel: $('calibMarkStbdLabel'),
  calibFullGrid: $('calibFullGrid'),
  calibMarkPortKnuckle: $('calibMarkPortKnuckle'),
  calibMarkPortTip: $('calibMarkPortTip'),
  calibMarkStbdKnuckle: $('calibMarkStbdKnuckle'),
  calibMarkStbdTip: $('calibMarkStbdTip'),
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

// Fixed, calibrated AC40 bow-camera preset: on centreline, ~0.75m forward
// of the ONBOARD_BASE mount reference, ~0.36m below it, aimed straight aft
// (pan 0, tilt 0) at the camera's real 58-degree FOV.
// This is the page's initial state AND what "Reset" restores -- from here
// the user should normally only touch foil cant / ride height / heel /
// trim to match a given photo, not the camera itself.
const DEFAULT_CAMERA = {
  mode: 'onboard',
  mount: 'bow',
  foreAft: -0.75,
  heightAboveDeck: -0.36,
  athwartshipsOffset: 0.00,
  panDeg: 0.0,
  tiltDeg: 0.0,
  fovDeg: 58.0
};

const defaults = {
  cantPort: 55,
  cantStbd: 55,
  heel: 0,
  trim: 0,
  ridePosition: 0,
  camAlong: DEFAULT_CAMERA.foreAft,
  camHeight: DEFAULT_CAMERA.heightAboveDeck,
  camAthwart: DEFAULT_CAMERA.athwartshipsOffset,
  camPan: DEFAULT_CAMERA.panDeg,
  camTilt: DEFAULT_CAMERA.tiltDeg,
  camFov: DEFAULT_CAMERA.fovDeg
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
  // in the viewer. Independent of the Reset button — resetting the
  // boat/camera calibration shouldn't throw away photo alignment work.
  photoOffsetX: 0,
  photoOffsetY: 0,
  photoScale: 1,

  // In onboard mode, dragging/scrolling the viewport always moves the
  // photo (OrbitControls is off there, so there's no gesture conflict). In
  // external mode the same drag/scroll normally orbits/zooms the free
  // camera instead -- this flag is the "Move photo" toggle that switches
  // the viewport over to photo pan/zoom instead, so a photo can still be
  // aligned to the boat from an external/chase-boat view. Always reset to
  // false on a camera-mode switch (see setCameraMode()).
  photoMoveMode: false,

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
  calibSingleSide: 'port',

  // 'full' mode: instead of scaling/repositioning the photo to a fixed
  // camera, solve for the camera itself (position, pan/tilt, and FOV) from
  // however many of these four foil landmarks are visible and marked --
  // works on any photo, including third-party broadcast shots where the
  // camera's real mount and lens are unknown. See solveCameraFromMarks().
  calibFullMarks: { portKnuckle: null, portTip: null, stbdKnuckle: null, stbdTip: null },
  calibFullPicking: null
};

// Onboard rig base position, in boat-local coordinates (X = fore/aft,
// bow at larger X; Y = up; Z = athwartships, starboard positive). Derived
// from the hull's bounding box (bow tip near X=11.8, deck near Y=1.0 at the
// bow) plus a real-world estimate of the mount, on the bowsprit ahead of
// the bow. camAlong/camHeight/camAthwart (see DEFAULT_CAMERA above) are
// OFFSETS from this fixed reference point, not absolute positions -- the
// calibrated bow preset below sits 1.10m aft of it and 0.38m below it, not
// at (0, 0, 0) exactly on it. There is only one physical bow camera (it
// doesn't move between tacks), so there's only one onboard "Bow" preset
// below, not a leeward/windward pair.
const ONBOARD_BASE = new THREE.Vector3(12.95, 1.38, 0);

const ONBOARD_PRESETS = {
  'bow': {
    along: DEFAULT_CAMERA.foreAft,
    height: DEFAULT_CAMERA.heightAboveDeck,
    athwart: DEFAULT_CAMERA.athwartshipsOffset,
    pan: DEFAULT_CAMERA.panDeg,
    tilt: DEFAULT_CAMERA.tiltDeg
  },
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
let portWaterGuide, stbdWaterGuide;

// Lookup tables for the "Solve camera" full-solve mode (see the block below
// applyOnboardPreset for the rest of that feature) -- declared up here,
// before initScene()/bindUI() run below, since renderCalibPins() (called
// from onResize() during initScene()) references FULL_MARK_ORDER and a
// const declared further down would still be in its temporal dead zone at
// that point, crashing the whole module on load.
const FULL_MARK_LABELS = {
  portKnuckle: 'port foil knuckle',
  portTip: 'port foil outer tip',
  stbdKnuckle: 'starboard foil knuckle',
  stbdTip: 'starboard foil outer tip'
};
const FULL_MARK_ORDER = ['portKnuckle', 'portTip', 'stbdKnuckle', 'stbdTip'];
const FULL_SOLVE_LANDMARKS = {
  portKnuckle: () => portFoilMarker,
  portTip: () => portFoilTrueTip,
  stbdKnuckle: () => stbdFoilMarker,
  stbdTip: () => stbdFoilTrueTip
};
let waterPlane, waterGrid;
let modelReady = false;
let modelMeshes = [];
let photoLoaded = false;

const tempV = new THREE.Vector3();
const tempV2 = new THREE.Vector3();

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
      createFoilWaterGuides();

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

// A canted foil below 90 degrees rakes outward toward (or through) the
// water in a way that's easy to misjudge in perspective. Two different
// reference lines matter here, so each guide draws both:
//  - the TIP line: the real foil rake, followed from the knuckle straight
//    through the outer tip and on to the water plane -- i.e. where the
//    physical foil itself actually meets the surface. Drawn in accent cyan.
//  - the VERTICAL line: a true plumb line dropped straight down from the
//    tip to the water plane. Because the raked foil line doesn't read as
//    "vertical" to the eye in perspective, this gives an unambiguous
//    vertical reference alongside it. Drawn in violet.
// Both end in a ring marking exactly where they cross the water, and both
// render on top of the hull (depthTest off) so they're never hidden behind
// the model.
const WATER_GUIDE_COLOR_TIP = 0x47e7db;
const WATER_GUIDE_COLOR_TIP_NEAR = 0xffcb6b;
const WATER_GUIDE_COLOR_VERTICAL = 0xb98dfb;

function buildWaterGuideLine(color) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const mat = new THREE.LineDashedMaterial({
    color,
    dashSize: 0.06,
    gapSize: 0.05,
    transparent: true,
    opacity: 0.92,
    depthTest: false
  });
  const line = new THREE.Line(geom, mat);
  line.renderOrder = 999;
  return line;
}

function buildWaterGuideRing(color) {
  const ringGeom = new THREE.RingGeometry(0.09, 0.16, 32);
  ringGeom.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthTest: false
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.renderOrder = 999;
  return ring;
}

function buildFoilWaterGuide() {
  const group = new THREE.Group();
  group.visible = false;

  const tipLine = buildWaterGuideLine(WATER_GUIDE_COLOR_TIP);
  const tipRing = buildWaterGuideRing(WATER_GUIDE_COLOR_TIP);
  const verticalLine = buildWaterGuideLine(WATER_GUIDE_COLOR_VERTICAL);
  const verticalRing = buildWaterGuideRing(WATER_GUIDE_COLOR_VERTICAL);
  group.add(tipLine, tipRing, verticalLine, verticalRing);

  return { group, tipLine, tipRing, verticalLine, verticalRing };
}

function createFoilWaterGuides() {
  portWaterGuide = buildFoilWaterGuide();
  stbdWaterGuide = buildFoilWaterGuide();
  scene.add(portWaterGuide.group);
  scene.add(stbdWaterGuide.group);
}

function setWaterGuideLine(line, from, to) {
  const positions = line.geometry.attributes.position;
  positions.setXYZ(0, from.x, from.y, from.z);
  positions.setXYZ(1, to.x, to.y, to.z);
  positions.needsUpdate = true;
  line.computeLineDistances();
}

// Beyond this, a genuine knuckle->tip crossing point is too far an
// extrapolation from the tip to be a useful "where it meets the water"
// marker (a near-horizontal rake can otherwise send it shooting off to an
// unhelpful, offscreen point) -- in that case the rake-line marker is
// simply skipped and only the always-present vertical reference is shown.
const WATER_GUIDE_RAKE_CAP = 3.0;

function updateSideWaterGuide(cantDeg, knuckleObj, tipObj, guide) {
  if (!guide || !tipObj || !knuckleObj) return;
  if (cantDeg >= 90 || !ui.waterlineToggle.checked) {
    guide.group.visible = false;
    return;
  }

  tipObj.getWorldPosition(tempV);
  knuckleObj.getWorldPosition(tempV2);
  const tip = tempV.clone();
  const knuckle = tempV2.clone();

  const nearSurface = Math.abs(tip.y) < 0.08;
  const tipColor = nearSurface ? WATER_GUIDE_COLOR_TIP_NEAR : WATER_GUIDE_COLOR_TIP;

  guide.group.visible = true;

  // Rake line: the real foil member, from the knuckle through the outer
  // tip, solved for where that true (possibly extended) line crosses the
  // water plane -- i.e. where the physical foil itself meets the surface,
  // not a synthetic straight-down guess.
  const dy = knuckle.y - tip.y;
  let rakeShown = false;
  if (Math.abs(dy) > 1e-6) {
    const t = knuckle.y / dy;
    const rakeCross = knuckle.clone().lerp(tip, t);
    rakeCross.y = 0;
    if (rakeCross.distanceTo(tip) <= WATER_GUIDE_RAKE_CAP) {
      setWaterGuideLine(guide.tipLine, tip, rakeCross);
      guide.tipLine.material.color.setHex(tipColor);
      guide.tipRing.position.set(rakeCross.x, 0.004, rakeCross.z);
      guide.tipRing.material.color.setHex(tipColor);
      guide.tipRing.material.opacity = nearSurface ? 0.95 : 0.75;
      rakeShown = true;
    }
  }
  guide.tipLine.visible = rakeShown;
  guide.tipRing.visible = rakeShown;

  // Vertical line: a true plumb line straight down from the tip -- an
  // unambiguous "vertical" reference alongside the rake line above, always
  // shown whenever this foil is below 90 degrees.
  const vertCross = new THREE.Vector3(tip.x, 0, tip.z);
  setWaterGuideLine(guide.verticalLine, tip, vertCross);
  guide.verticalRing.position.set(vertCross.x, 0.004, vertCross.z);
  guide.verticalLine.visible = true;
  guide.verticalRing.visible = true;
}

function updateFoilWaterGuides() {
  if (!modelReady) return;
  updateSideWaterGuide(state.cantPort, portFoilMarker, portFoilTrueTip, portWaterGuide);
  updateSideWaterGuide(state.cantStbd, stbdFoilMarker, stbdFoilTrueTip, stbdWaterGuide);
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
  ui.calibSolveBtn.addEventListener('click', () => {
    if (state.calibMode === 'full') solveCameraFromMarks();
    else solveCalibration();
  });
  ui.calibClearBtn.addEventListener('click', clearCalibPins);

  if (ui.calibModeSpan && ui.calibModeSingle) {
    ui.calibModeSpan.addEventListener('click', () => setCalibMode('span'));
    ui.calibModeSingle.addEventListener('click', () => setCalibMode('single'));
    ui.calibSidePort.addEventListener('click', () => setCalibSingleSide('port'));
    ui.calibSideStbd.addEventListener('click', () => setCalibSingleSide('stbd'));
    updateCalibModeUI();
  }

  if (ui.calibModeFull) {
    ui.calibModeFull.addEventListener('click', () => setCalibMode('full'));
    ui.calibMarkPortKnuckle.addEventListener('click', () => startFullMarkPick('portKnuckle'));
    ui.calibMarkPortTip.addEventListener('click', () => startFullMarkPick('portTip'));
    ui.calibMarkStbdKnuckle.addEventListener('click', () => startFullMarkPick('stbdKnuckle'));
    ui.calibMarkStbdTip.addEventListener('click', () => startFullMarkPick('stbdTip'));
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
    updateFoilWaterGuides();
  });

  document.querySelectorAll('#cameraMode button').forEach((button) => {
    button.addEventListener('click', () => setCameraMode(button.dataset.mode));
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
// zoom it -- gated by isPhotoDragEnabled() (always on in onboard mode;
// external mode only while the "Move photo" toggle is on, since that same
// drag/scroll otherwise drives OrbitControls instead) and only once a
// photo is loaded. Listening on viewportBox rather than the photo layer
// itself means this still works even though the WebGL canvas sits on top
// and receives the raw event first — mousedown/wheel bubble up to this
// ancestor either way.
let photoDrag = null;

function bindPhotoInteraction() {
  ui.viewportBox.addEventListener('mousedown', (e) => {
    if (!isPhotoDragEnabled() || !photoLoaded) return;

    if (state.calibPicking || state.calibFullPicking) {
      const photoRect = ui.photoImg.getBoundingClientRect();
      const fx = (e.clientX - photoRect.left) / photoRect.width;
      const fy = (e.clientY - photoRect.top) / photoRect.height;
      if (state.calibFullPicking) placeFullMark(state.calibFullPicking, fx, fy);
      else placeCalibPin(state.calibPicking, fx, fy);
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
    if (!isPhotoDragEnabled() || !photoLoaded) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    state.photoScale = Math.min(4, Math.max(0.4, state.photoScale * factor));
    applyPhotoTransform();
  }, { passive: false });

  ui.viewportBox.addEventListener('mousemove', (e) => {
    if ((!state.calibPicking && !state.calibFullPicking) || !photoLoaded) return;
    const photoRect = ui.photoImg.getBoundingClientRect();
    const fx = (e.clientX - photoRect.left) / photoRect.width;
    const fy = (e.clientY - photoRect.top) / photoRect.height;
    positionCalibLoupe(e.clientX, e.clientY, fx, fy);
  });

  ui.viewportBox.addEventListener('mouseleave', () => {
    if (state.calibPicking || state.calibFullPicking) hideCalibLoupe();
  });

  ui.resetPhotoBtn.addEventListener('click', resetPhotoTransform);

  if (ui.movePhotoToggle) {
    ui.movePhotoToggle.addEventListener('click', () => {
      state.photoMoveMode = !state.photoMoveMode;
      controls.enabled = state.cameraMode === 'external' && !state.photoMoveMode;
      updatePhotoDragUI();
    });
  }
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
  if (!state.calibPicking && !state.calibFullPicking) return;
  state.calibPicking = null;
  state.calibFullPicking = null;
  ui.calibMarkPort.classList.remove('active');
  ui.calibMarkStbd.classList.remove('active');
  if (ui.calibMarkPortKnuckle) {
    ui.calibMarkPortKnuckle.classList.remove('active');
    ui.calibMarkPortTip.classList.remove('active');
    ui.calibMarkStbdKnuckle.classList.remove('active');
    ui.calibMarkStbdTip.classList.remove('active');
  }
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
  state.calibFullMarks = { portKnuckle: null, portTip: null, stbdKnuckle: null, stbdTip: null };
  cancelCalibPicking();
  ui.calibClearBtn.disabled = true;
  ui.calibSolveBtn.disabled = true;
  ui.calibHint.textContent = calibModeHintText();
  renderCalibPins();
}

// The default (no pins placed yet) hint text for whichever calibration mode
// is currently active -- factored out so clearCalibPins() and mode switches
// both stay in sync without repeating the three strings.
function calibModeHintText() {
  if (state.calibMode === 'full') {
    return 'Click a mark button below, then click that point on the photo. Mark 2–4 of the foil knuckle/tip points — more points, spread across both foils, give a tighter camera fit. This solves for the camera’s own position, aim and field of view to match the photo, instead of scaling the photo to a fixed camera.';
  }
  if (state.calibMode === 'single') {
    return 'Click a "Mark" button, then click that point on the photo. With both the knuckle and the outer tip marked, this scales and repositions the photo so that span lands exactly on the model\'s current foil.';
  }
  return 'Click a "Mark" button, then click that foil tip on the photo. With both pins placed, this scales and repositions the photo so its marked span lands exactly on the model\'s current foil tips.';
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
  const full = state.calibMode === 'full';
  ui.calibModeSpan.classList.toggle('active', !single && !full);
  ui.calibModeSingle.classList.toggle('active', single);
  if (ui.calibModeFull) ui.calibModeFull.classList.toggle('active', full);

  ui.calibSideRow.classList.toggle('is-hidden', !single);
  ui.calibSidePort.classList.toggle('active', state.calibSingleSide === 'port');
  ui.calibSideStbd.classList.toggle('active', state.calibSingleSide === 'stbd');

  if (ui.calibPinRow) ui.calibPinRow.classList.toggle('is-hidden', full);
  if (ui.calibFullGrid) ui.calibFullGrid.classList.toggle('is-hidden', !full);

  if (single) {
    const side = state.calibSingleSide === 'port' ? 'port' : 'starboard';
    ui.calibMarkPortLabel.textContent = 'Mark knuckle';
    ui.calibMarkStbdLabel.textContent = 'Mark outer tip';
    ui.calibBlockHint.textContent = `Only the ${side} foil is visible -- mark its knuckle (where the strut bends into the tip) and its outer tip to scale and anchor the photo.`;
  } else if (full) {
    ui.calibBlockHint.textContent = 'Works on any photo, even one where the camera’s real position and lens are unknown (e.g. a broadcast shot) — mark 2–4 foil points and this solves for the camera itself.';
  } else {
    ui.calibMarkPortLabel.textContent = 'Mark port tip';
    ui.calibMarkStbdLabel.textContent = 'Mark stbd tip';
    ui.calibBlockHint.textContent = 'Mark both foil tips on the photo to scale and anchor it to the model.';
  }

  ui.calibSolveBtn.textContent = full ? 'Solve camera' : 'Scale photo to match';
}

// Re-anchors the two pin dots to their stored fraction of the photo
// image's own on-screen rect, so they stay glued to the photo through
// drag/zoom and window resizes.
function renderCalibPins() {
  if (!ui.calibPinLayer) return;
  ui.calibPinLayer.innerHTML = '';

  const hasSpanPins = state.calibPortPx || state.calibStbdPx;
  const hasFullMarks = FULL_MARK_ORDER.some((k) => state.calibFullMarks[k]);
  if (!hasSpanPins && !hasFullMarks) return;

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
  addPin(state.calibFullMarks.portKnuckle, 'port-knuckle');
  addPin(state.calibFullMarks.portTip, 'port-tip');
  addPin(state.calibFullMarks.stbdKnuckle, 'stbd-knuckle');
  addPin(state.calibFullMarks.stbdTip, 'stbd-tip');
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

// ---------------------------------------------------------------------
// "Solve camera" mode: instead of scaling the photo to a camera whose
// position/lens is already known (the two modes above), mark 2-4
// recognizable foil landmarks and solve for the onboard camera's own
// position, pan, tilt AND field of view that best reproduces those points
// -- works on any photo, including third-party broadcast shots where the
// real camera mount and lens are unknown. Uses a Levenberg-Marquardt
// nonlinear least-squares fit (numeric Jacobian) against pixel
// reprojection error, reusing the exact same onboard-camera rig and
// projection math the sliders/solveCalibration() already use.
// ---------------------------------------------------------------------

function startFullMarkPick(key) {
  if (state.cameraMode !== 'onboard' || !photoLoaded) return;
  state.calibFullPicking = key;
  state.calibPicking = null;
  ui.calibMarkPort.classList.remove('active');
  ui.calibMarkStbd.classList.remove('active');
  ui.calibMarkPortKnuckle.classList.toggle('active', key === 'portKnuckle');
  ui.calibMarkPortTip.classList.toggle('active', key === 'portTip');
  ui.calibMarkStbdKnuckle.classList.toggle('active', key === 'stbdKnuckle');
  ui.calibMarkStbdTip.classList.toggle('active', key === 'stbdTip');
  ui.viewportBox.classList.add('calib-picking');
  ui.calibHint.textContent = `Click the ${FULL_MARK_LABELS[key]} on the photo.`;
}

function placeFullMark(key, fx, fy) {
  const px = { fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) };
  state.calibFullMarks[key] = px;

  const markedCount = FULL_MARK_ORDER.filter((k) => state.calibFullMarks[k]).length;
  ui.calibClearBtn.disabled = markedCount === 0;
  ui.calibSolveBtn.disabled = markedCount < 2;

  const nextKey = FULL_MARK_ORDER.find((k) => !state.calibFullMarks[k]);
  if (nextKey) {
    // Chain into the next unmarked point, same as the span/single modes --
    // keeps the click-click-click flow going without extra button presses.
    startFullMarkPick(nextKey);
    if (markedCount >= 2) {
      ui.calibHint.textContent = `${markedCount} of 4 marked — click "Solve camera" now, or click the ${FULL_MARK_LABELS[nextKey]} to add another point for a tighter fit.`;
    }
  } else {
    cancelCalibPicking();
    ui.calibHint.textContent = 'All 4 points marked. Click "Solve camera" to fit the camera to them.';
  }

  renderCalibPins();
}

// Generic Levenberg-Marquardt least-squares minimizer with a numeric
// (finite-difference) Jacobian -- residualFn(params) -> [r0, r1, ...] is
// the only thing callers supply, so this has no knowledge of cameras or
// pixels and could be reused for any other least-squares fit later.
function levenbergMarquardt(residualFn, x0, opts = {}) {
  const maxIter = opts.maxIter || 100;
  const eps = opts.eps || 1e-10;
  let lambda = opts.lambda || 1e-3;
  let x = x0.slice();
  let r = residualFn(x);
  let cost = r.reduce((s, v) => s + v * v, 0);

  for (let iter = 0; iter < maxIter; iter++) {
    const n = x.length;
    const m = r.length;

    const J = Array.from({ length: m }, () => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const h = Math.max(1e-4, Math.abs(x[j]) * 1e-4);
      const xph = x.slice();
      xph[j] += h;
      const rph = residualFn(xph);
      for (let i = 0; i < m; i++) J[i][j] = (rph[i] - r[i]) / h;
    }

    const JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
    const Jtr = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += J[i][a] * J[i][b];
        JtJ[a][b] = s;
      }
      let s = 0;
      for (let i = 0; i < m; i++) s += J[i][a] * r[i];
      Jtr[a] = s;
    }

    let improved = false;
    for (let attempt = 0; attempt < 12 && !improved; attempt++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v + lambda * (JtJ[a][a] || 1e-6) : v)));
      const b = Jtr.map((v) => -v);
      const delta = solveLinearSystem(A, b);
      if (!delta) { lambda *= 4; continue; }

      const xNew = x.map((v, i) => v + delta[i]);
      const rNew = residualFn(xNew);
      const costNew = rNew.reduce((s, v) => s + v * v, 0);

      if (costNew < cost) {
        const rel = (cost - costNew) / Math.max(cost, 1e-12);
        x = xNew; r = rNew; cost = costNew;
        lambda = Math.max(lambda * 0.4, 1e-9);
        improved = true;
        if (rel < eps) return { x, cost, iterations: iter };
      } else {
        lambda *= 4;
      }
    }
    if (!improved) break;
  }
  return { x, cost, iterations: maxIter };
}

// Small Gauss-Jordan solver with partial pivoting -- n is at most 6 here
// (the camera parameters), so nothing fancier is needed.
function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    if (pivot !== col) { const tmp = M[col]; M[col] = M[pivot]; M[pivot] = tmp; }
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col] / M[col][col];
      for (let c = col; c <= n; c++) M[row][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function solveCameraFromMarks() {
  if (!modelReady) return;
  const activeKeys = FULL_MARK_ORDER.filter((k) => state.calibFullMarks[k]);
  if (activeKeys.length < 2) return;

  const boxRect = ui.viewportBox.getBoundingClientRect();
  const boxWidth = boxRect.width;
  const boxHeight = boxRect.height;
  const photoRect = ui.photoImg.getBoundingClientRect();

  const targets = activeKeys.map((k) => calibPinToBoxPx(state.calibFullMarks[k], boxRect, photoRect));

  // World-space positions of the matching model landmarks in the boat's
  // CURRENT pose (cant/heel/trim/ride height) -- only the camera moves
  // during the search below, the boat itself stays put.
  boatRoot.updateMatrixWorld(true);
  const worldPositions = activeKeys.map((k) => {
    const v = new THREE.Vector3();
    FULL_SOLVE_LANDMARKS[k]().getWorldPosition(v);
    return v;
  });

  const paramNames = ['camAlong', 'camHeight', 'camAthwart', 'camPan', 'camTilt', 'camFov'];
  const x0 = paramNames.map((p) => state[p]);

  // Same physical envelope as the sliders themselves (see index.html's
  // min/max on each control). Clamping every parameter to this range on
  // every residual evaluation -- not just after the fact -- keeps a
  // genuinely underdetermined 2-point solve from "perfectly" fitting by
  // wandering off to a nonsense pose (camera facing backwards through the
  // hull, 130 degrees of tilt) that happens to zero out the two residuals;
  // it's forced to find its zero-or-near-zero error within the same
  // physically plausible envelope a person dragging the sliders would.
  const PARAM_BOUNDS = [[-3, 3], [-0.5, 2], [-1.5, 1.5], [-90, 90], [-60, 60], [20, 140]];
  const clampParams = (p) => p.map((v, i) => Math.min(PARAM_BOUNDS[i][1], Math.max(PARAM_BOUNDS[i][0], v)));

  // Forward model: place the real onboard camera exactly as
  // updateOnboardCamera() would for these 6 (clamped) parameters, then
  // project each landmark -- reuses the same rig/projection the sliders
  // already drive, so the solved values slot straight back into them.
  const applyParams = (pRaw) => {
    const [along, height, athwart, pan, tilt, fov] = clampParams(pRaw);
    const pos = ONBOARD_BASE.clone();
    pos.x += along; pos.y += height; pos.z += athwart;
    camera.position.copy(pos);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(
      THREE.MathUtils.degToRad(tilt),
      THREE.MathUtils.degToRad(90 + pan),
      0
    );
    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };

  const projectToBoxPx = (worldPos) => {
    const p = worldPos.clone().project(camera);
    return {
      x: (p.x * 0.5 + 0.5) * boxWidth,
      y: (1 - (p.y * 0.5 + 0.5)) * boxHeight
    };
  };

  // Mild ridge regularization toward the sliders' current values, weighted
  // low relative to a pixel error. This keeps the solve well-posed with
  // only 2-3 points (otherwise underdetermined) without meaningfully
  // distorting a well-constrained 4-point fit.
  const regWeight = [0.4, 0.4, 0.4, 0.02, 0.02, 0.01];

  const residualFn = (p) => {
    applyParams(p);
    const residuals = [];
    for (let i = 0; i < activeKeys.length; i++) {
      const proj = projectToBoxPx(worldPositions[i]);
      residuals.push(proj.x - targets[i].x);
      residuals.push(proj.y - targets[i].y);
    }
    for (let j = 0; j < p.length; j++) {
      residuals.push(regWeight[j] * (p[j] - x0[j]));
    }
    return residuals;
  };

  const result = levenbergMarquardt(residualFn, x0, { maxIter: 150 });
  const solved = clampParams(result.x);

  applyParams(solved);
  state.camAlong = solved[0];
  state.camHeight = solved[1];
  state.camAthwart = solved[2];
  state.camPan = solved[3];
  state.camTilt = solved[4];
  state.camFov = solved[5];

  ui.camAlong.value = state.camAlong; ui.camAlongValue.textContent = `${signed(state.camAlong, 2)} m`;
  ui.camHeight.value = state.camHeight; ui.camHeightValue.textContent = `${signed(state.camHeight, 2)} m`;
  ui.camAthwart.value = state.camAthwart; ui.camAthwartValue.textContent = `${signed(state.camAthwart, 2)} m`;
  ui.camPan.value = state.camPan; ui.camPanValue.textContent = `${signed(state.camPan, 1)}°`;
  ui.camTilt.value = state.camTilt; ui.camTiltValue.textContent = `${signed(state.camTilt, 1)}°`;
  ui.camFov.value = state.camFov; ui.camFovValue.textContent = `${state.camFov.toFixed(0)}°`;

  updateGeometry();

  // RMS pixel reprojection error over just the point residuals (not the
  // regularization terms) -- the number that actually says how well the
  // solved camera explains the marked points.
  const pointResiduals = residualFn(solved).slice(0, activeKeys.length * 2);
  const rms = Math.sqrt(pointResiduals.reduce((s, v) => s + v * v, 0) / pointResiduals.length);
  const under = activeKeys.length < 3;

  ui.calibHint.textContent = `Solved from ${activeKeys.length} point${activeKeys.length === 1 ? '' : 's'}: `
    + `FOV ${state.camFov.toFixed(1)}°, pan ${signed(state.camPan, 1)}°, tilt ${signed(state.camTilt, 1)}°, `
    + `mount ${signed(state.camAlong, 2)}/${signed(state.camHeight, 2)}/${signed(state.camAthwart, 2)} m (fore-aft/height/athwart). `
    + `RMS fit error ${rms.toFixed(1)}px.`
    + (under ? ' Only 2 points marked — this is underdetermined (regularized toward the sliders’ starting values); mark 3–4 for a fully independent solve.' : '');
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

// Switches between onboard (rigidly hull-mounted) and external (free)
// camera modes -- pulled out of its own click handler so resetAll() can
// force the page back to onboard mode too, not just reset the sliders.
// True whenever a drag/scroll on the viewport should move/zoom the photo
// rather than do whatever else that gesture normally does (nothing extra
// in onboard mode; orbit/zoom the free camera in external mode). Onboard
// mode has no gesture conflict (OrbitControls is off there) so photo drag
// is always on; external mode only hands the gesture to the photo while
// the "Move photo" toggle is on, since the same drag also drives the
// camera there.
function isPhotoDragEnabled() {
  return state.cameraMode === 'onboard' || (state.cameraMode === 'external' && state.photoMoveMode);
}

function updatePhotoDragUI() {
  const enabled = isPhotoDragEnabled();
  ui.viewportBox.classList.toggle('photo-draggable', enabled);
  if (ui.movePhotoToggle) {
    ui.movePhotoToggle.hidden = state.cameraMode !== 'external';
    ui.movePhotoToggle.classList.toggle('active', state.photoMoveMode);
  }
  if (ui.photoDragHint) {
    ui.photoDragHint.textContent = state.cameraMode === 'external'
      ? (state.photoMoveMode
        ? 'Move photo is on — drag the photo in the viewer to reposition it, scroll to zoom. Turn it off to orbit the camera again.'
        : 'Turn on "Move photo" below to drag/scroll the photo into alignment — otherwise dragging orbits the camera.')
      : 'Drag the photo in the viewer to reposition it, scroll to zoom.';
  }
}

function setCameraMode(mode) {
  document.querySelectorAll('#cameraMode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  state.cameraMode = mode;
  state.photoMoveMode = false;
  ui.onboardPresets.hidden = state.cameraMode !== 'onboard';
  ui.externalPresets.hidden = state.cameraMode === 'onboard';
  ui.onboardControls.hidden = state.cameraMode !== 'onboard';
  if (state.cameraMode !== 'onboard') cancelCalibPicking();
  controls.enabled = state.cameraMode === 'external';
  updatePhotoDragUI();
  ui.cameraHint.textContent = state.cameraMode === 'onboard'
    ? 'Onboard mode keeps the camera bolted to the hull — it follows heel, trim and ride height automatically. Use the sliders to nudge the mount position and aim.'
    : 'Drag to orbit, scroll to zoom. External mode is a free camera in space — for a chase-boat, drone or TV shot rather than a boat-mounted one.';
  applyCameraMode();
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
  updateFoilWaterGuides();
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

  // Full camera reset: back to onboard/bow AND the calibrated default
  // mount/aim/FOV -- not just the mount offsets applyOnboardPreset('bow')
  // covers, since FOV (and the mode itself, if the user had switched to
  // External) are part of the fixed default preset too.
  setCameraMode('onboard');
  applyOnboardPreset('bow');
  document.querySelectorAll('#onboardPresets .preset-button').forEach((b) => b.classList.toggle('active', b.dataset.preset === 'bow'));

  state.camFov = defaults.camFov;
  ui.camFov.value = defaults.camFov;
  ui.camFovValue.textContent = `${defaults.camFov.toFixed(0)}°`;
  camera.fov = defaults.camFov;
  camera.updateProjectionMatrix();

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
const SNAPSHOT_THEME = {
  bg: '#06101b',
  surface: '#0a1725',
  line: 'rgba(132, 151, 174, 0.18)',
  lineStrong: 'rgba(71, 231, 219, 0.30)',
  text: '#edf5fb',
  muted: '#8fa2b5',
  accent: '#47e7db'
};

function captureMatchSnapshot() {
  const rect = ui.viewportBox.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const captionHeight = 108;
  const T = SNAPSHOT_THEME;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height + captionHeight;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = T.bg;
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

  // Soft vignette where the image meets the caption band, so the band's top
  // edge reads cleanly against a bright photo or model instead of a hard seam.
  const vignetteH = Math.min(64, height * 0.18);
  if (vignetteH > 0) {
    const vignette = ctx.createLinearGradient(0, height - vignetteH, 0, height);
    vignette.addColorStop(0, 'rgba(6, 16, 27, 0)');
    vignette.addColorStop(1, 'rgba(6, 16, 27, 0.72)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, height - vignetteH, width, vignetteH);
  }

  // Caption band, styled to match the app's own dark surface + headline KPI
  // strip rather than a plain text overlay.
  ctx.fillStyle = T.surface;
  ctx.fillRect(0, height, width, captionHeight);
  ctx.fillStyle = T.lineStrong;
  ctx.fillRect(0, height, width, 2);

  const padX = 16;
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left';
  ctx.fillStyle = T.accent;
  ctx.font = '800 11px Inter, ui-sans-serif, sans-serif';
  try { ctx.letterSpacing = '0.12em'; } catch (err) { /* not supported */ }
  ctx.fillText('AC40 · PHOTO MATCH', padX, height + 21);
  try { ctx.letterSpacing = '0px'; } catch (err) { /* not supported */ }

  ctx.textAlign = 'right';
  ctx.fillStyle = T.muted;
  ctx.font = '400 11px Inter, ui-sans-serif, sans-serif';
  const labelSource = photoLoaded ? ui.photoFileName.textContent : 'No photo loaded';
  ctx.fillText(`${labelSource}  ·  ${new Date().toLocaleString()}`, width - padX, height + 21);

  ctx.fillStyle = T.line;
  ctx.fillRect(padX, height + 30, width - padX * 2, 1);

  const kpis = [
    { label: 'CANT PORT', value: `${state.cantPort.toFixed(1)}°` },
    { label: 'CANT STARBOARD', value: `${state.cantStbd.toFixed(1)}°` },
    { label: 'SINK PORT', value: ui.outSinkPort.textContent },
    { label: 'SINK STARBOARD', value: ui.outSinkStbd.textContent }
  ];
  const colW = (width - padX * 2) / kpis.length;
  ctx.textAlign = 'left';
  kpis.forEach((kpi, i) => {
    const colX = padX + colW * i;
    if (i > 0) {
      ctx.fillStyle = T.line;
      ctx.fillRect(colX, height + 42, 1, captionHeight - 54);
    }
    const textX = colX + (i > 0 ? 16 : 0);

    ctx.fillStyle = T.muted;
    ctx.font = '700 9.5px Inter, ui-sans-serif, sans-serif';
    try { ctx.letterSpacing = '0.05em'; } catch (err) { /* not supported */ }
    ctx.fillText(kpi.label, textX, height + 58);
    try { ctx.letterSpacing = '0px'; } catch (err) { /* not supported */ }

    ctx.fillStyle = T.accent;
    ctx.font = '800 19px Inter, ui-sans-serif, sans-serif';
    ctx.fillText(kpi.value, textX, height + 84);
  });

  ctx.strokeStyle = T.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);

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
