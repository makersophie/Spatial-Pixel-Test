const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');

const VIDEO_CONSTRAINTS = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    // Prefer the rear camera on phones; laptops ignore this.
    facingMode: { ideal: 'environment' },
  },
  audio: false,
};

// ---------------------------------------------------------------------------
// Supply matching
//
// Three need cards and three resource cards. A need card is matched while
// its resource card is anywhere in the frame.
// ---------------------------------------------------------------------------

// Keys are the text inside the printed QR codes; `name` is the label shown.
const CARDS = {
  'object-a': { name: 'need-water', kind: 'need', type: 'water' },
  'object-c': { name: 'need-light', kind: 'need', type: 'light' },
  'object-b': { name: 'need-medicine', kind: 'need', type: 'medicine' },
  'bottle': { name: 'water', kind: 'resource', type: 'water' },
  'phone': { name: 'light', kind: 'resource', type: 'light' },
  'notebook': { name: 'medicine', kind: 'resource', type: 'medicine' },
  // Characters that move around the printed map (see cards.html).
  'mouse-1': { name: 'mouse-1', kind: 'mouse' },
  'mouse-2': { name: 'mouse-2', kind: 'mouse' },
  'human': { name: 'human', kind: 'human' },
};

const NEED_COLOR = '#ff0000';
const MATCHED_COLOR = '#00ff00';
const ANCHOR_COLOR = '#ffcc00';
const MAP_COLOR = 'rgba(0, 200, 255, 0.9)';

function parseCard(text) {
  return CARDS[text.trim().toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Camera setup
// ---------------------------------------------------------------------------

navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS)
  .then((stream) => {
    video.srcObject = stream;
    // Continuous autofocus helps codes held close to the lens stay sharp.
    // Browsers that don't support it just ignore the request.
    const [track] = stream.getVideoTracks();
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  })
  .catch((error) => {
    console.error('Unable to access webcam:', error);
  });

let started = false;

video.addEventListener('loadedmetadata', () => {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;

  if (!started) {
    started = true;
    startDetection();
    requestAnimationFrame(render);
  }
});

// ---------------------------------------------------------------------------
// Detection
//
// Codes can appear anywhere from tiny (card far from the camera) to filling
// the frame (card held right in front of it). Two strategies:
//
// 1. The browser's native BarcodeDetector (Chrome/Edge). It finds every code
//    in a frame at any size and is fast, so it's used whenever available.
// 2. A jsQR fallback. jsQR only decodes one code per call and struggles when
//    a code is much bigger or smaller than it expects, so the frame is
//    scanned as an image pyramid: several downscaled copies, each tiled into
//    overlapping windows sized for one band of code sizes.
// ---------------------------------------------------------------------------

// How long it takes to sweep every scale once. Tracks must outlive this, or
// codes only found at one scale would blink in and out.
let scanCycleMs = 0;

async function startDetection() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        runNativeDetection(detector);
        return;
      }
    } catch (error) {
      console.warn('BarcodeDetector unavailable, falling back to jsQR:', error);
    }
  }

  runPyramidDetection();
}

// Codes far from the camera can be too small for the detector to resolve.
// So every other frame, one region of the image (a 2x2 grid of overlapping
// regions, taken in turn) is enlarged and scanned as well.
const ZOOM = 2;
const ZOOM_REGION = 0.6;
const ZOOM_ORIGINS = [[0, 0], [1, 0], [0, 1], [1, 1]];

const zoomCanvas = document.createElement('canvas');
const zoomCtx = zoomCanvas.getContext('2d');
let nativeFrame = 0;
let zoomCycleStartedAt = 0;

async function runNativeDetection(detector) {
  if (video.readyState >= video.HAVE_ENOUGH_DATA) {
    try {
      if (nativeFrame % 2 === 0) {
        reportNativeCodes(await detector.detect(video), { x: 0, y: 0, scale: 1 });
      } else {
        const region = prepareZoomRegion((nativeFrame - 1) / 2 % ZOOM_ORIGINS.length);
        reportNativeCodes(await detector.detect(zoomCanvas), region);
      }
    } catch (error) {
      console.error('Detection failed:', error);
    }
    nativeFrame++;
  }

  requestAnimationFrame(() => runNativeDetection(detector));
}

function prepareZoomRegion(index) {
  if (index === 0) {
    const now = performance.now();
    if (zoomCycleStartedAt) {
      scanCycleMs = now - zoomCycleStartedAt;
    }
    zoomCycleStartedAt = now;
  }

  const width = Math.round(video.videoWidth * ZOOM_REGION);
  const height = Math.round(video.videoHeight * ZOOM_REGION);
  const [col, row] = ZOOM_ORIGINS[index];
  const x = col * (video.videoWidth - width);
  const y = row * (video.videoHeight - height);

  if (zoomCanvas.width !== width * ZOOM || zoomCanvas.height !== height * ZOOM) {
    zoomCanvas.width = width * ZOOM;
    zoomCanvas.height = height * ZOOM;
  }
  zoomCtx.imageSmoothingQuality = 'high';
  zoomCtx.drawImage(video, x, y, width, height, 0, 0, zoomCanvas.width, zoomCanvas.height);

  return { x, y, scale: ZOOM };
}

// Map corners from the scanned image back to full-resolution frame space.
function reportNativeCodes(codes, { x, y, scale }) {
  for (const code of codes) {
    const [tl, tr, br, bl] = code.cornerPoints.map((point) => ({
      x: x + point.x / scale,
      y: y + point.y / scale,
    }));
    reportDetection(code.rawValue, {
      topLeftCorner: tl,
      topRightCorner: tr,
      bottomRightCorner: br,
      bottomLeftCorner: bl,
    });
  }
}

// Each level targets codes of roughly `qrSize` pixels in the source frame.
// The level is downscaled so those codes come out around TARGET_QR_PX, which
// is a size jsQR decodes reliably, and so big codes are cheap to scan.
const PYRAMID_LEVELS = [1000, 420, 180, 80];
const TARGET_QR_PX = 90;
// Windows are three code-widths wide and step by two, so neighbouring
// windows overlap by one code-width and no code can fall across a seam.
const TILE_FACTOR = 3;
const STEP_FACTOR = 2;
// Milliseconds of jsQR work per animation frame; the rest of a pass carries
// over to the next frame so the page stays responsive.
const SCAN_BUDGET_MS = 24;

const pyramid = PYRAMID_LEVELS.map((qrSize) => {
  const canvas = document.createElement('canvas');
  return {
    qrSize,
    canvas,
    ctx: canvas.getContext('2d', { willReadFrequently: true }),
    scale: 1,
  };
});

let scanJobs = [];
let passStartedAt = 0;

function runPyramidDetection() {
  if (video.readyState >= video.HAVE_ENOUGH_DATA) {
    if (scanJobs.length === 0) {
      if (passStartedAt) {
        scanCycleMs = performance.now() - passStartedAt;
      }
      scanJobs = startPyramidPass();
      passStartedAt = performance.now();
    }

    const deadline = performance.now() + SCAN_BUDGET_MS;
    while (scanJobs.length > 0 && performance.now() < deadline) {
      scanTile(scanJobs.shift());
    }
  }

  requestAnimationFrame(runPyramidDetection);
}

// Snapshot the current frame into every pyramid level and queue up all of
// their tiles, coarsest (largest codes, fewest tiles) first.
function startPyramidPass() {
  const jobs = [];

  for (const level of pyramid) {
    level.scale = Math.min(1, TARGET_QR_PX / level.qrSize);
    const width = Math.round(video.videoWidth * level.scale);
    const height = Math.round(video.videoHeight * level.scale);
    if (level.canvas.width !== width || level.canvas.height !== height) {
      level.canvas.width = width;
      level.canvas.height = height;
    }
    level.ctx.drawImage(video, 0, 0, width, height);

    const qrPx = level.qrSize * level.scale;
    const tileWidth = Math.min(width, Math.round(qrPx * TILE_FACTOR));
    const tileHeight = Math.min(height, Math.round(qrPx * TILE_FACTOR));
    const step = Math.round(qrPx * STEP_FACTOR);

    for (const y of getTilePositions(height, tileHeight, step)) {
      for (const x of getTilePositions(width, tileWidth, step)) {
        jobs.push({ level, x, y, width: tileWidth, height: tileHeight });
      }
    }
  }

  return jobs;
}

// Start offsets for tiles of `tile` covering `dimension`, stepping by `step`
// and with a final tile flush against the far edge so the whole frame is
// covered even when it doesn't divide evenly by the step.
function getTilePositions(dimension, tile, step) {
  if (dimension <= tile) {
    return [0];
  }

  const positions = [];
  for (let pos = 0; pos + tile <= dimension; pos += step) {
    positions.push(pos);
  }

  const lastPosition = dimension - tile;
  if (positions[positions.length - 1] !== lastPosition) {
    positions.push(lastPosition);
  }

  return positions;
}

// Need and resource cards sit right next to each other, so a tile often
// holds more than one code. jsQR only returns one per call, so after each
// hit the code is painted over and the same tile is scanned again.
const MAX_CODES_PER_TILE = 4;

function scanTile({ level, x, y, width, height }) {
  for (let i = 0; i < MAX_CODES_PER_TILE; i++) {
    const tile = level.ctx.getImageData(x, y, width, height);
    const qrCode = jsQR(tile.data, width, height, { inversionAttempts: 'dontInvert' });
    if (!qrCode) {
      return;
    }

    const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = qrCode.location;
    const inLevel = [topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner]
      .map((point) => ({ x: point.x + x, y: point.y + y }));
    maskCode(level.ctx, inLevel);

    // Map the corners from level space back to full-resolution frame space.
    const [tl, tr, br, bl] = inLevel.map((point) => ({
      x: point.x / level.scale,
      y: point.y / level.scale,
    }));
    reportDetection(qrCode.data, {
      topLeftCorner: tl,
      topRightCorner: tr,
      bottomRightCorner: br,
      bottomLeftCorner: bl,
    });
  }
}

// jsQR's corners sit on the finder pattern centres, so grow the quad a bit
// before filling it to make sure the whole code is covered.
function maskCode(ctx, corners) {
  const cx = corners.reduce((sum, p) => sum + p.x, 0) / 4;
  const cy = corners.reduce((sum, p) => sum + p.y, 0) / 4;
  const grow = 1.4;

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  corners.forEach((p, i) => {
    const px = cx + (p.x - cx) * grow;
    const py = cy + (p.y - cy) * grow;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  });
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Tracking
//
// Detections are folded into tracks that persist briefly after a code is
// last seen. This dedupes the same code found in several pyramid tiles,
// and stops overlays flickering when a code is missed for a frame or two.
// ---------------------------------------------------------------------------

const tracks = [];
let nextTrackId = 1;

function reportDetection(data, location) {
  const card = parseCard(data);
  const center = centerOf(location);
  const size = sizeOf(location);
  const now = performance.now();

  const existing = tracks.find((track) => {
    if (track.data !== data) {
      return false;
    }
    const distance = Math.hypot(track.center.x - center.x, track.center.y - center.y);
    return distance < Math.max(track.size, size) * 1.5;
  });

  if (existing) {
    Object.assign(existing, { location, center, size, lastSeen: now });
  } else {
    tracks.push({ id: nextTrackId++, data, card, location, center, size, lastSeen: now });
  }
}

function pruneTracks(now) {
  const ttl = Math.max(350, scanCycleMs * 1.5);
  for (let i = tracks.length - 1; i >= 0; i--) {
    if (now - tracks[i].lastSeen > ttl) {
      tracks.splice(i, 1);
    }
  }
}

function centerOf(location) {
  const points = cornersOf(location);
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / 4,
    y: points.reduce((sum, p) => sum + p.y, 0) / 4,
  };
}

// Average side length, used as the code's apparent size.
function sizeOf(location) {
  const points = cornersOf(location);
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total / 4;
}

function cornersOf(location) {
  return [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner,
  ];
}

// ---------------------------------------------------------------------------
// Map calibration
//
// The printed map (map.html) has a QR anchor at each corner. While all four
// are in frame, a homography is fitted from their centres in the frame to
// their known positions on the floor plan, so any code in the frame can be
// placed on the map. The last fit is kept when an anchor is briefly hidden
// (e.g. by a hand), on the assumption that the map and camera stay put.
// ---------------------------------------------------------------------------

let frameToMap = null;
let mapToFrame = null;
let calibrationLive = false;

function updateCalibration() {
  const frame = [];
  const map = [];
  for (const [text, position] of Object.entries(MAP.anchors)) {
    const track = tracks.find((t) => t.data.trim().toLowerCase() === text);
    if (!track) {
      calibrationLive = false;
      return;
    }
    frame.push(quadCenter(track.location));
    map.push(position);
  }

  const forward = solveHomography(frame, map);
  const inverse = solveHomography(map, frame);
  calibrationLive = Boolean(forward && inverse);
  if (calibrationLive) {
    frameToMap = forward;
    mapToFrame = inverse;
  }
}

// Under perspective the average of the corners drifts off-centre, but the
// diagonals still cross at the true centre of the code.
function quadCenter(location) {
  const [a, b, c, d] = cornersOf(location);
  const denom = (a.x - c.x) * (b.y - d.y) - (a.y - c.y) * (b.x - d.x);
  if (Math.abs(denom) < 1e-9) {
    return centerOf(location);
  }
  const t = ((a.x - b.x) * (b.y - d.y) - (a.y - b.y) * (b.x - d.x)) / denom;
  return { x: a.x + t * (c.x - a.x), y: a.y + t * (c.y - a.y) };
}

// Fits the 3x3 matrix H (with H[2][2] = 1) mapping four `src` points onto
// four `dst` points, by solving the standard 8x8 linear system.
function solveHomography(src, dst) {
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) {
        pivot = r;
      }
    }
    if (Math.abs(rows[pivot][col]) < 1e-9) {
      return null;
    }
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];

    for (let r = 0; r < 8; r++) {
      if (r !== col) {
        const factor = rows[r][col] / rows[col][col];
        for (let k = col; k < 9; k++) {
          rows[r][k] -= factor * rows[col][k];
        }
      }
    }
  }

  const h = rows.map((row, i) => row[8] / row[i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function applyHomography(h, { x, y }) {
  const w = h[6] * x + h[7] * y + h[8];
  return {
    x: (h[0] * x + h[1] * y + h[2]) / w,
    y: (h[3] * x + h[4] * y + h[5]) / w,
  };
}

// Where a track sits on the floor plan, and which room that is.
function placeOnMap(track) {
  if (!frameToMap) {
    return null;
  }
  const point = applyHomography(frameToMap, track.center);
  return { point, zone: zoneAt(point) };
}

// Location queries, handy from the console:
//   whereIs('need-water')   -> 'kitchen'
//   whoIsIn('mouse hole')   -> ['bottle', ...] or [] if empty
function whereIs(name) {
  const track = tracks.find((t) => (t.card?.name ?? t.data) === name);
  return track ? placeOnMap(track)?.zone ?? null : null;
}

function whoIsIn(zone) {
  return tracks
    .filter((t) => !isMapAnchor(t.data) && placeOnMap(t)?.zone === zone)
    .map((t) => t.card?.name ?? t.data);
}

// ---------------------------------------------------------------------------
// Reactions
//
// From the Spatial Computing Mouse brief: a character's reaction depends on
// the room it is in, unless another character is right next to it.
//   object + location = status, and mouse + human / mouse + mouse = event.
// Each reaction shows a speech bubble and plays a short sound when it starts.
// ---------------------------------------------------------------------------

const PLACE_REACTIONS = {
  mouse: {
    'kitchen': { text: 'Food stolen!', sound: 'sneak' },
    'mouse hole': { text: 'Home sweet home. Safe!', sound: 'home' },
    'living room': { text: 'Scared of being killed!', sound: 'scared' },
  },
  human: {
    'kitchen': { text: 'Preparing food', sound: 'cook' },
    'mouse hole': { text: 'The wall has a hole. Needs patching!', sound: 'fix' },
    'living room': { text: 'Relaxing...', sound: 'relax' },
  },
};

// Meetings involve two cards but show one bubble (see render).
const CAUGHT = { text: 'Caught! Game over', sound: 'gameover', shared: true };
const MICE_MEET = { text: 'Happy happy!!!', sound: 'happy', shared: true };

// Two characters "meet" when their centres are this many card widths apart.
const MEET_DISTANCE = 2.5;

function isNear(a, b) {
  const distance = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);
  return distance < Math.max(a.size, b.size) * MEET_DISTANCE;
}

function reactionFor(track, zone) {
  const kind = track.card?.kind;
  if (kind !== 'mouse' && kind !== 'human') {
    return null;
  }

  const others = tracks.filter((t) => t !== track && isNear(t, track));
  if (kind === 'mouse') {
    if (others.some((t) => t.card?.kind === 'human')) {
      return CAUGHT;
    }
    if (others.some((t) => t.card?.kind === 'mouse')) {
      return MICE_MEET;
    }
  } else if (others.some((t) => t.card?.kind === 'mouse')) {
    return CAUGHT;
  }

  return PLACE_REACTIONS[kind][zone] ?? null;
}

// Short synthesised jingles, as [frequency Hz, seconds] notes.
const SOUNDS = {
  sneak: [[660, 0.08], [880, 0.08], [660, 0.08]],
  home: [[523, 0.15], [659, 0.15], [784, 0.3]],
  scared: [[220, 0.12], [208, 0.12], [196, 0.35]],
  cook: [[440, 0.1], [0, 0.05], [440, 0.1]],
  fix: [[300, 0.07], [0, 0.07], [300, 0.07], [0, 0.07], [300, 0.07]],
  relax: [[392, 0.35], [330, 0.45]],
  gameover: [[392, 0.2], [330, 0.2], [262, 0.6]],
  happy: [[784, 0.1], [988, 0.1], [1175, 0.1], [1568, 0.25]],
};

// Browsers only allow audio after the user interacts with the page, so the
// first tap or click anywhere turns sound on.
let audio = null;
window.addEventListener('pointerdown', () => {
  audio ??= new AudioContext();
  audio.resume();
});

function playSound(name) {
  if (!audio || audio.state !== 'running') {
    return;
  }
  let at = audio.currentTime;
  for (const [frequency, duration] of SOUNDS[name]) {
    if (frequency > 0) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.08, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + duration);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + duration);
    }
    at += duration;
  }
}

// ---------------------------------------------------------------------------
// Matching and rendering
// ---------------------------------------------------------------------------

const thanksLayer = document.getElementById('thanks');
const thanksElements = new Map();

function render(now) {
  pruneTracks(now);
  updateCalibration();

  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  drawMap();

  const shown = new Set();
  let gameOver = false;
  // Cards that already showed a meeting this frame, so their partner doesn't
  // repeat the same bubble and sound.
  const met = [];
  for (const track of tracks) {
    if (isMapAnchor(track.data)) {
      drawBox(track.location, ANCHOR_COLOR);
      continue;
    }

    const matched = isMatched(track);
    const color = track.card?.kind === 'need' && !matched ? NEED_COLOR : MATCHED_COLOR;
    drawBox(track.location, color);
    const name = track.card?.name ?? track.data;
    const zone = placeOnMap(track)?.zone;
    drawLabel(track.location, zone ? `${name} @ ${zone}` : name);

    const reaction = reactionFor(track, zone);
    const partnerShown = reaction?.shared &&
      met.some((other) => other.reaction === reaction && isNear(other, track));
    if (reaction && reaction !== track.reaction && !partnerShown) {
      playSound(reaction.sound);
    }
    track.reaction = reaction;
    if (reaction && !partnerShown) {
      drawBubble(track.location, reaction.text);
      if (reaction.shared) {
        met.push(track);
      }
    }
    gameOver ||= reaction === CAUGHT;

    if (matched) {
      showThanks(track);
      shown.add(track.id);
    }
  }

  for (const [id, element] of thanksElements) {
    if (!shown.has(id)) {
      element.remove();
      thanksElements.delete(id);
    }
  }

  if (gameOver) {
    drawBanner('GAME OVER');
  }

  requestAnimationFrame(render);
}

// A need card is matched while its resource card is anywhere in the frame.
function isMatched(track) {
  if (track.card?.kind !== 'need') {
    return false;
  }
  return tracks.some((other) => other.card?.kind === 'resource' && other.card.type === track.card.type);
}

// The image is a DOM element over the video (not drawn into the canvas) so
// animated GIFs keep playing. It sits in the centre of the screen, clear of
// the code, and is rotated to follow the need card's angle.
function showThanks(track) {
  let element = thanksElements.get(track.id);
  if (!element) {
    element = document.createElement('figure');
    element.className = 'thanks';
    element.innerHTML = '<img src="thank-you.jpg" alt="">';
    thanksLayer.appendChild(element);
    thanksElements.set(track.id, element);
  }

  // The video is scaled uniformly (object-fit: cover), so the code's angle in
  // the frame is the same as on screen.
  const { topLeftCorner, topRightCorner } = track.location;
  const angle = Math.atan2(topRightCorner.y - topLeftCorner.y, topRightCorner.x - topLeftCorner.x);
  element.style.transform = `rotate(${angle}rad)`;
}

// Outlines the floor plan and its rooms on top of the video, so it's easy to
// see whether the calibration lines up. Dashed once an anchor is out of view.
function drawMap() {
  if (!mapToFrame) {
    return;
  }

  overlayCtx.save();
  overlayCtx.strokeStyle = MAP_COLOR;
  overlayCtx.lineWidth = Math.max(2, overlay.width * 0.003);
  overlayCtx.setLineDash(calibrationLive ? [] : [12, 8]);

  const rects = [{ x: 0, y: 0, width: MAP.width, height: MAP.height }, ...MAP.zones];
  for (const rect of rects) {
    const corners = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
      { x: rect.x, y: rect.y + rect.height },
    ].map((p) => applyHomography(mapToFrame, p));

    overlayCtx.beginPath();
    corners.forEach((p, i) => (i === 0 ? overlayCtx.moveTo(p.x, p.y) : overlayCtx.lineTo(p.x, p.y)));
    overlayCtx.closePath();
    overlayCtx.stroke();
  }
  overlayCtx.restore();
}

function drawBox(location, color) {
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = location;

  overlayCtx.strokeStyle = color;
  overlayCtx.lineWidth = Math.max(4, overlay.width * 0.006);
  overlayCtx.beginPath();
  overlayCtx.moveTo(topLeftCorner.x, topLeftCorner.y);
  overlayCtx.lineTo(topRightCorner.x, topRightCorner.y);
  overlayCtx.lineTo(bottomRightCorner.x, bottomRightCorner.y);
  overlayCtx.lineTo(bottomLeftCorner.x, bottomLeftCorner.y);
  overlayCtx.closePath();
  overlayCtx.stroke();
}

// A white speech bubble above the card, pointing down at it.
function drawBubble(location, text) {
  const points = cornersOf(location);
  const cx = points.reduce((sum, p) => sum + p.x, 0) / 4;
  const top = Math.min(...points.map((p) => p.y));

  const fontSize = Math.max(18, overlay.width * 0.022);
  const padding = fontSize * 0.5;
  const tail = fontSize * 0.6;
  overlayCtx.font = `bold ${fontSize}px sans-serif`;
  overlayCtx.textBaseline = 'middle';
  const width = overlayCtx.measureText(text).width + padding * 2;
  const height = fontSize + padding * 2;
  const x = Math.min(Math.max(cx - width / 2, 0), overlay.width - width);
  const y = Math.max(top - tail - height, 0);

  overlayCtx.fillStyle = '#fff';
  overlayCtx.strokeStyle = '#000';
  overlayCtx.lineWidth = Math.max(2, fontSize * 0.1);
  overlayCtx.beginPath();
  overlayCtx.roundRect(x, y, width, height, fontSize * 0.4);
  overlayCtx.moveTo(cx - tail * 0.6, y + height);
  overlayCtx.lineTo(cx, y + height + tail);
  overlayCtx.lineTo(cx + tail * 0.6, y + height);
  overlayCtx.fill();
  overlayCtx.stroke();
  // Hide the bubble's bottom edge where the tail joins it.
  overlayCtx.fillRect(cx - tail * 0.6 + overlayCtx.lineWidth, y + height - overlayCtx.lineWidth,
    tail * 1.2 - overlayCtx.lineWidth * 2, overlayCtx.lineWidth * 2);

  overlayCtx.fillStyle = '#000';
  overlayCtx.fillText(text, x + padding, y + height / 2);
}

function drawBanner(text) {
  const fontSize = overlay.width * 0.09;
  overlayCtx.font = `bold ${fontSize}px sans-serif`;
  overlayCtx.textAlign = 'center';
  overlayCtx.textBaseline = 'middle';
  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  overlayCtx.fillRect(0, overlay.height / 2 - fontSize, overlay.width, fontSize * 2);
  overlayCtx.fillStyle = '#ff3b30';
  overlayCtx.fillText(text, overlay.width / 2, overlay.height / 2);
  overlayCtx.textAlign = 'start';
}

function drawLabel(location, text) {
  const { bottomLeftCorner, bottomRightCorner } = location;

  const fontSize = Math.max(16, overlay.width * 0.02);
  const padding = fontSize * 0.25;
  const x = Math.min(bottomLeftCorner.x, bottomRightCorner.x);
  const y = Math.max(bottomLeftCorner.y, bottomRightCorner.y) + padding;

  overlayCtx.font = `${fontSize}px monospace`;
  overlayCtx.textBaseline = 'top';
  const textWidth = overlayCtx.measureText(text).width;

  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  overlayCtx.fillRect(x - padding, y - padding, textWidth + padding * 2, fontSize + padding * 2);

  overlayCtx.fillStyle = '#00ff00';
  overlayCtx.fillText(text, x, y);
}
